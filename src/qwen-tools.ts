/**
 * qwen-tools.ts
 *
 * Tool registry for the Qwen agent harness. Exports:
 *  - TOOL_SCHEMAS: OpenAI-format tool array passed to qwen-client.chat()
 *  - executeTool(name, args, ctx): runs the tool, returns a string result
 *  - isValidToolName(name): quick membership check
 *
 * NOTE: `task_complete` appears in TOOL_SCHEMAS but has NO executor — the
 * harness handles it as a stop signal BEFORE dispatch, so executeTool never
 * sees it. We throw here as a defensive fallback.
 *
 * Tools NOT yet implemented (Team C owns the memory/facts layer):
 *   remember, recall
 */

import { mkdir, readFile, readdir, writeFile, unlink } from "fs/promises";
import { join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import type OpenAI from "openai";

import {
  commitCanon,
  pushCanon,
  getCanonStatus,
  resetCanon,
  CanonError,
} from "./canon-commit.js";
import { createSessionAndAwait } from "./claude-runner.js";
import {
  list as listMemory,
  forget as forgetMemory,
  remember as rememberMemory,
  type MemoryRow,
} from "./qwen-memory.js";
import {
  readFacts,
  deleteFact,
  writeFact,
  type FactType,
  type FactSource,
} from "./shared-facts.js";
import {
  isEnabled as mpEnabled,
  mpSearch,
  mpAddDrawer,
  mpListDrawers,
  mpDeleteDrawer,
  mpGetDrawer,
} from "./mempalace-client.js";

// ---------------------------------------------------------------------------
// Config / path validation
// ---------------------------------------------------------------------------

const CANON_ROOT =
  process.env.CANON_TRUTH_ROOT ||
  "/mnt/c/dev/dcc/SPARK/training_data_truth/canon";
const CANON_SEARCH_URL =
  process.env.CANON_SEARCH_URL || "http://localhost:3001/search";
const READ_CANON_MAX_BYTES = 100 * 1024; // 100 KB
const CANON_SEARCH_TIMEOUT_MS = 5000;

// TODO(shared-canon-constants): canon-commit.ts does not currently export
// VALID_DOMAINS. We duplicate the set here — keep in sync. When a shared
// constants module lands, replace this local copy.
const VALID_DOMAINS = new Set([
  "resistance",
  "bestiary",
  "world_bible",
  "factions",
  "technology",
  "facility_ops",
]);

const SUBDOMAIN_RE = /^[a-z0-9_-]+$/;
const FILENAME_RE = /^[a-z0-9_-]+\.md$/;

function validateCanonPath(
  domain: string,
  subdomain: string | undefined,
  filename: string | undefined,
): void {
  if (!VALID_DOMAINS.has(domain)) {
    throw new Error(
      `Invalid domain '${domain}'. Must be one of: ${Array.from(VALID_DOMAINS).join(", ")}`,
    );
  }
  if (subdomain !== undefined && !SUBDOMAIN_RE.test(subdomain)) {
    throw new Error(`Invalid subdomain '${subdomain}'. Must match ${SUBDOMAIN_RE}`);
  }
  if (filename !== undefined && !FILENAME_RE.test(filename)) {
    throw new Error(`Invalid filename '${filename}'. Must match ${FILENAME_RE}`);
  }
}

// ---------------------------------------------------------------------------
// Tool schemas (terse — schema descriptions cost context tokens)
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "canon_search",
      description: "Semantic search of existing canon documents.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query." },
          n_results: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "canon_commit",
      description:
        "Write a canon markdown file and commit it to the Qwen worktree branch.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", enum: Array.from(VALID_DOMAINS) },
          subdomain: { type: "string", description: "Lowercase [a-z0-9_-]+." },
          filename: { type: "string", description: "Lowercase [a-z0-9_-]+.md." },
          content: { type: "string", description: "Full file contents, max 100KB." },
          message: { type: "string", description: "Commit message." },
          overwrite: { type: "boolean", default: false },
        },
        required: ["domain", "subdomain", "filename", "content", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "canon_push",
      description: "Push the current Qwen canon branch to origin.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "canon_status",
      description: "Report current Qwen canon branch and pending push state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "canon_reset",
      description: "Destroy the current Qwen canon worktree and clear state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_canon",
      description: "Read a committed canon file from training_data_truth.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", enum: Array.from(VALID_DOMAINS) },
          subdomain: { type: "string" },
          filename: { type: "string" },
        },
        required: ["domain", "subdomain", "filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_canon",
      description: "List files under a canon domain (and optional subdomain).",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", enum: Array.from(VALID_DOMAINS) },
          subdomain: { type: "string" },
        },
        required: ["domain"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_claudecode",
      description:
        "Delegate a self-contained task to Claude Code and await its text reply.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 900_000 },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Write an entry to your per-channel vector memory. Use for episodic facts you want to recall later in this channel via list_memory or automatic recall (e.g. naming decisions, user preferences specific to this conversation, important context to revisit). Channel-scoped — invisible to other channels and other agents. For cross-agent facts use add_fact instead.",
      parameters: {
        type: "object",
        properties: {
          fact_type: {
            type: "string",
            enum: ["naming", "decision", "user_preference", "context"],
            description: "Category of memory entry.",
          },
          content: {
            type: "string",
            description:
              "The thing to remember. Keep it short and self-contained — under ~500 chars works best for vector recall.",
          },
        },
        required: ["fact_type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_fact",
      description:
        "Write a CROSS-AGENT shared fact (visible to Qwen, ClaudeCode, NemoClaw). Use for ground-truth that all three agents should respect: canonical names, user preferences, project decisions. Tell the user this affects all agents before calling it. For private per-channel notes use remember instead.",
      parameters: {
        type: "object",
        properties: {
          fact_type: {
            type: "string",
            enum: ["naming", "decision", "user_preference", "context"],
            description: "Category. Use 'naming' for canonical names, 'decision' for project choices, 'user_preference' for how the user wants you to behave, 'context' for general background.",
          },
          content: {
            type: "string",
            description: "The fact, ≤500 chars. Keep it terse and self-contained.",
          },
        },
        required: ["fact_type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memory",
      description:
        "List vector memories. If `query` is given, returns semantic matches; otherwise returns most-recent rows. Use this BEFORE forget_memory so the user can see what will be deleted.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional semantic search query. Omit for recency listing.",
          },
          channel_id: {
            type: "string",
            description: "Optional channel scope; defaults to ALL channels when omitted.",
          },
          top_k: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description:
        "Delete one or more vector-memory rows by id. ALWAYS call list_memory first and confirm with the user before calling this.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            description: "UUIDs returned from list_memory.",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
          },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_facts",
      description:
        "List shared facts (cross-agent ground truth — affects Qwen, ClaudeCode, NemoClaw). Optional filters by type and limit.",
      parameters: {
        type: "object",
        properties: {
          types: {
            type: "array",
            items: {
              type: "string",
              enum: ["naming", "decision", "user_preference", "context"],
            },
          },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_fact",
      description:
        "Delete a shared fact by id. Affects ALL agents that read shared-facts — Qwen, ClaudeCode, and NemoClaw. Always tell the user this before calling it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Fact UUID from list_facts." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mempalace_get_drawer",
      description:
        "Re-fetch the full body of a MemPalace drawer by id. Use this when a tool result in your conversation history was replaced with a structured pointer (json with _kind='tool_result_pointer' and a drawer_id) and you need the original content to answer the user. Cheap call — re-fetches without re-running the original tool.",
      parameters: {
        type: "object",
        properties: {
          drawer_id: {
            type: "string",
            description:
              "The drawer_id from a tool_result_pointer message in your history.",
          },
        },
        required: ["drawer_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_session",
      description:
        "Archive the current Qwen session file for this channel and start fresh on the next turn. Requires confirm:true to prevent accidents. Use when the user says 'forget this whole conversation'.",
      parameters: {
        type: "object",
        properties: {
          confirm: { type: "boolean", description: "Must be true." },
        },
        required: ["confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_complete",
      description:
        "Signal that the user's request is fully handled. Provide a brief inline summary, optionally attach up to 5 files, and optionally surface durable facts you learned during this turn so they're saved to long-term memory.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Brief final answer for the user (inline)." },
          attachments: {
            type: "array",
            description:
              "Optional files to upload with the reply. Max 5 files, 50KB each. Use for long drafts rather than stuffing them into `summary`.",
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description:
                    "Filename with extension. Allowed: .md .txt .json .yaml .yml .log .csv. Must match ^[a-zA-Z0-9_.-]+$.",
                },
                content: {
                  type: "string",
                  description: "File contents. Max 50KB each.",
                },
              },
              required: ["name", "content"],
            },
          },
          facts: {
            type: "array",
            description:
              "Durable facts learned this turn worth saving to long-term memory. Each fact is short (≤300 chars), self-contained, and CONCRETE — not 'we discussed X' but 'X = Y'. Skip if nothing durable was learned. The middleware writes each fact to a MemPalace drawer in the appropriate room, surfaceable later via mempalace_search.",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "decision",
                    "naming",
                    "user_preference",
                    "canon_observation",
                  ],
                  description:
                    "decision: a choice committed to (e.g. 'using angle 03 for hackers_shift'). naming: canonical name resolved (e.g. 'PROVISION = NNCDR alias'). user_preference: how the user wants future work done. canon_observation: a fact extracted from canon_search/read_canon worth retaining.",
                },
                content: {
                  type: "string",
                  description: "The fact itself, ≤300 chars, declarative.",
                },
                kg_triple: {
                  type: "object",
                  description:
                    "Optional structured form for KG storage. Use when the fact is genuinely entity-relationship-entity (max 128 chars per field).",
                  properties: {
                    subject: { type: "string" },
                    predicate: { type: "string" },
                    object: { type: "string" },
                    valid_from: {
                      type: "string",
                      description: "ISO date or year (e.g. '2042-03-15' or '2042'); optional.",
                    },
                  },
                  required: ["subject", "predicate", "object"],
                },
              },
              required: ["type", "content"],
            },
          },
        },
        required: ["summary"],
      },
    },
  },
];

const TOOL_NAMES = new Set(TOOL_SCHEMAS.map((t) => t.function.name));

export function isValidToolName(name: string): boolean {
  return TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Executor context — minimal for now; harness passes session-scoped data in.
// ---------------------------------------------------------------------------

export interface ToolContext {
  channelId: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Individual tool implementations
// ---------------------------------------------------------------------------

async function runCanonSearch(args: {
  query: string;
  n_results?: number;
}): Promise<string> {
  if (typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("canon_search: 'query' must be a non-empty string");
  }
  // Clamp n_results to the schema's advertised [1, 20] range even though
  // the schema says so — LLMs sometimes ignore schemas and emit 5000.
  const rawN = args.n_results ?? 5;
  const n = Math.max(1, Math.min(20, Math.floor(rawN)));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CANON_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(CANON_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: args.query, n_results: n }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`canon_search HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    return JSON.stringify(json);
  } finally {
    clearTimeout(timer);
  }
}

async function runCanonCommit(args: {
  domain: string;
  subdomain: string;
  filename: string;
  content: string;
  message: string;
  overwrite?: boolean;
}): Promise<string> {
  if (
    !args.domain ||
    !args.subdomain ||
    !args.filename ||
    typeof args.content !== "string" ||
    !args.message
  ) {
    throw new Error(
      "canon_commit: domain, subdomain, filename, content, message are required",
    );
  }
  try {
    const result = await commitCanon({
      domain: args.domain,
      subdomain: args.subdomain,
      filename: args.filename,
      content: args.content,
      message: args.message,
      overwrite: args.overwrite,
      agent: "qwen",
    });
    return JSON.stringify(result);
  } catch (err) {
    // 409 on unchanged content is "already good" per the plan — treat as success.
    if (
      err instanceof CanonError &&
      err.statusCode === 409 &&
      /content unchanged/i.test(err.message)
    ) {
      return JSON.stringify({
        status: "no_op",
        reason: "content unchanged — treated as success",
        path: `SPARK/output/canon/nemoclaw/${args.domain}/${args.subdomain}/${args.filename}`,
      });
    }
    throw err;
  }
}

async function runCanonPush(): Promise<string> {
  const result = await pushCanon("qwen");
  return JSON.stringify(result);
}

async function runCanonStatus(): Promise<string> {
  const result = await getCanonStatus("qwen");
  return JSON.stringify(result);
}

async function runCanonReset(): Promise<string> {
  const result = await resetCanon("qwen");
  return JSON.stringify(result);
}

async function runReadCanon(args: {
  domain: string;
  subdomain: string;
  filename: string;
}): Promise<string> {
  validateCanonPath(args.domain, args.subdomain, args.filename);
  const rootAbs = resolve(CANON_ROOT);
  const target = resolve(rootAbs, args.domain, args.subdomain, args.filename);
  // Robust traversal check: if the target relative to rootAbs starts with
  // ".." or is absolute, it's outside rootAbs. Safer than prefix matching
  // against `rootAbs + "/"` which breaks when rootAbs has a trailing slash.
  const rel = relative(rootAbs, target);
  if (rel.startsWith("..") || resolve(rootAbs, rel) !== target) {
    throw new Error("Path traversal detected");
  }
  const buf = await readFile(target);
  if (buf.byteLength > READ_CANON_MAX_BYTES) {
    // Still return a readable preview rather than erroring — harness can decide.
    return buf.slice(0, READ_CANON_MAX_BYTES).toString("utf-8") + "\n\n[TRUNCATED]";
  }
  return buf.toString("utf-8");
}

async function runListCanon(args: {
  domain: string;
  subdomain?: string;
}): Promise<string> {
  validateCanonPath(args.domain, args.subdomain, undefined);
  const rootAbs = resolve(CANON_ROOT);
  const dir = args.subdomain
    ? resolve(rootAbs, args.domain, args.subdomain)
    : resolve(rootAbs, args.domain);
  const rel = relative(rootAbs, dir);
  if (rel.startsWith("..") || (rel !== "" && resolve(rootAbs, rel) !== dir)) {
    throw new Error("Path traversal detected");
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return JSON.stringify(names);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`list_canon failed for ${dir}: ${msg}`);
  }
}

// --- Memory management tool executors ---

async function runRemember(
  args: { fact_type?: unknown; content?: unknown },
  ctx: ToolContext,
): Promise<string> {
  const allowedTypes = new Set(["naming", "decision", "user_preference", "context"]);
  if (typeof args.fact_type !== "string" || !allowedTypes.has(args.fact_type)) {
    throw new Error(
      `remember: fact_type must be one of ${[...allowedTypes].join(", ")}`,
    );
  }
  if (typeof args.content !== "string" || args.content.trim().length === 0) {
    throw new Error("remember: content must be a non-empty string");
  }
  if (args.content.length > 4000) {
    throw new Error("remember: content too long (>4000 chars); split it");
  }
  if (mpEnabled()) {
    const result = await mpAddDrawer("qwen", args.fact_type, args.content, {
      added_by: "qwen",
      source_file: `channel:${ctx.channelId}`,
    });
    return JSON.stringify({
      ok: result.success,
      drawer_id: result.drawer_id,
      wing: "qwen",
      room: args.fact_type,
      note: "stored in MemPalace qwen wing; use list_memory to verify",
    });
  }
  await rememberMemory(ctx.channelId, args.fact_type, args.content);
  return JSON.stringify({
    ok: true,
    channel_id: ctx.channelId,
    fact_type: args.fact_type,
    note: "stored in your per-channel vector memory; use list_memory to verify",
  });
}

async function runAddFact(args: {
  fact_type?: unknown;
  content?: unknown;
}): Promise<string> {
  const allowedTypes = new Set<FactType>([
    "naming",
    "decision",
    "user_preference",
    "context",
  ]);
  if (typeof args.fact_type !== "string" || !allowedTypes.has(args.fact_type as FactType)) {
    throw new Error(
      `add_fact: fact_type must be one of ${[...allowedTypes].join(", ")}`,
    );
  }
  if (typeof args.content !== "string" || args.content.trim().length === 0) {
    throw new Error("add_fact: content must be a non-empty string");
  }
  if (args.content.length > 500) {
    throw new Error("add_fact: content too long (>500 chars); shorten it");
  }
  if (mpEnabled()) {
    const result = await mpAddDrawer("shared", args.fact_type as string, args.content, {
      added_by: "qwen",
    });
    return JSON.stringify({
      ok: result.success,
      drawer_id: result.drawer_id,
      wing: "shared",
      room: args.fact_type,
      note: "shared fact written to MemPalace; visible to Qwen, ClaudeCode, and NemoClaw",
    });
  }
  const fact = await writeFact({
    source: "qwen" as FactSource,
    type: args.fact_type as FactType,
    content: args.content,
  });
  return JSON.stringify({
    ok: true,
    id: fact.id,
    fact_type: fact.type,
    note: "shared fact written; visible to Qwen, ClaudeCode, and NemoClaw",
  });
}

async function runListMemory(args: {
  query?: string;
  channel_id?: string;
  top_k?: number;
}): Promise<string> {
  const topK = Math.max(1, Math.min(50, Math.floor(args.top_k ?? 10)));
  if (mpEnabled()) {
    if (args.query && args.query.trim().length > 0) {
      const results = await mpSearch(args.query, { wing: "qwen", limit: topK });
      return JSON.stringify(
        results.map((r) => ({
          id: `mp:${r.wing}:${r.room}`,
          wing: r.wing,
          room: r.room,
          content: r.text,
          created_at: r.created_at,
          similarity: r.similarity,
        })),
      );
    }
    const drawers = await mpListDrawers({ wing: "qwen", limit: topK });
    return JSON.stringify(drawers);
  }
  const rows = await listMemory(
    args.channel_id,
    args.query && args.query.trim().length > 0 ? args.query : undefined,
    topK,
  );
  return JSON.stringify(
    rows.map((r: MemoryRow) => ({
      id: r.id,
      channel_id: r.channel_id,
      fact_type: r.fact_type,
      content: r.content,
      created_at: r.created_at,
      ...(r.similarity !== undefined ? { similarity: r.similarity } : {}),
    })),
  );
}

async function runForgetMemory(args: { ids?: unknown }): Promise<string> {
  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    throw new Error("forget_memory: 'ids' must be a non-empty array of UUIDs");
  }
  if (args.ids.length > 50) {
    throw new Error("forget_memory: refusing to delete >50 rows in one call");
  }
  const ids = args.ids.filter((x): x is string => typeof x === "string");
  if (ids.length === 0) {
    throw new Error("forget_memory: no valid string ids provided");
  }
  if (mpEnabled()) {
    let deleted = 0;
    for (const id of ids) {
      if (await mpDeleteDrawer(id)) deleted++;
    }
    return JSON.stringify({ deleted, ids });
  }
  const deleted = await forgetMemory(ids);
  return JSON.stringify({ deleted, ids });
}

async function runMempalaceGetDrawer(args: {
  drawer_id?: unknown;
}): Promise<string> {
  if (typeof args.drawer_id !== "string" || args.drawer_id.length === 0) {
    throw new Error("mempalace_get_drawer: 'drawer_id' must be a non-empty string");
  }
  if (!mpEnabled()) {
    throw new Error("mempalace_get_drawer: MEMPALACE_ENABLED is not set");
  }
  const result = await mpGetDrawer(args.drawer_id);
  if (result.error || !result.drawer) {
    throw new Error(
      `mempalace_get_drawer: ${result.error ?? "drawer not found"}`,
    );
  }
  // Return the FULL drawer text. The caller should be aware they're inflating
  // their context by doing this — they explicitly invoked the tool to re-read.
  return JSON.stringify({
    drawer_id: args.drawer_id,
    wing: result.drawer.wing,
    room: result.drawer.room,
    content: result.drawer.text,
    source_file: result.drawer.source_file,
    created_at: result.drawer.created_at,
  });
}

async function runListFacts(args: {
  types?: string[];
  limit?: number;
}): Promise<string> {
  const limit = args.limit ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
  const allowedTypes = new Set<FactType>([
    "naming",
    "decision",
    "user_preference",
    "context",
  ]);
  const types = Array.isArray(args.types)
    ? (args.types.filter((t): t is FactType =>
        typeof t === "string" && allowedTypes.has(t as FactType),
      ) as FactType[])
    : undefined;
  if (mpEnabled()) {
    const room = types && types.length === 1 ? types[0] : undefined;
    const drawers = await mpListDrawers({ wing: "shared", room, limit });
    return JSON.stringify(drawers);
  }
  const facts = await readFacts({ types, limit });
  return JSON.stringify(facts);
}

async function runForgetFact(args: { id?: string }): Promise<string> {
  if (typeof args.id !== "string" || args.id.length === 0) {
    throw new Error("forget_fact: 'id' must be a non-empty string");
  }
  if (mpEnabled()) {
    const removed = await mpDeleteDrawer(args.id);
    return JSON.stringify({
      removed,
      id: args.id,
      note: removed
        ? "Fact deleted from MemPalace shared hall (affects all agents)"
        : "No drawer with that id was found",
    });
  }
  const removed = await deleteFact(args.id);
  return JSON.stringify({
    removed,
    id: args.id,
    note: removed
      ? "Fact deleted for all agents (Qwen, ClaudeCode, NemoClaw)"
      : "No fact with that id was found",
  });
}

/**
 * Archive the current Qwen session file for a channel. Inlined here rather
 * than imported from qwen-harness.ts to avoid a circular import
 * (qwen-harness → qwen-tools → qwen-harness).
 */
async function archiveSessionFile(channelId: string): Promise<boolean> {
  const sessionsDir =
    process.env.QWEN_SESSIONS_DIR ??
    resolve(
      resolve(fileURLToPath(import.meta.url), ".."),
      "..",
      "qwen-sessions",
    );
  const src = join(sessionsDir, `${channelId}.json`);
  try {
    const raw = await readFile(src, "utf-8");
    const archiveDir = join(sessionsDir, "archive");
    await mkdir(archiveDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(archiveDir, `${channelId}_${ts}.json`);
    await writeFile(dest, raw, "utf-8");
    await unlink(src);
    return true;
  } catch {
    return false;
  }
}

async function runForgetSession(
  args: { confirm?: boolean },
  ctx: ToolContext,
): Promise<string> {
  if (args.confirm !== true) {
    throw new Error(
      "forget_session: must be called with { confirm: true }",
    );
  }
  const archived = await archiveSessionFile(ctx.channelId);
  return JSON.stringify({
    archived,
    channelId: ctx.channelId,
    note: archived
      ? "Session archived; next turn will start fresh"
      : "No active session file for this channel",
  });
}

async function runAskClaudeCode(args: {
  prompt: string;
  timeout_ms?: number;
}): Promise<string> {
  if (typeof args.prompt !== "string" || !args.prompt.trim()) {
    throw new Error("ask_claudecode: 'prompt' must be a non-empty string");
  }
  const text = await createSessionAndAwait(args.prompt, {
    suppressDiscordPost: true,
    timeoutMs: args.timeout_ms ?? 300_000,
  });
  return text;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  ctx: ToolContext,
): Promise<string> {
  if (!isValidToolName(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const a = args ?? {};
  switch (name) {
    case "canon_search":
      return runCanonSearch(a);
    case "canon_commit":
      return runCanonCommit(a);
    case "canon_push":
      return runCanonPush();
    case "canon_status":
      return runCanonStatus();
    case "canon_reset":
      return runCanonReset();
    case "read_canon":
      return runReadCanon(a);
    case "list_canon":
      return runListCanon(a);
    case "ask_claudecode":
      return runAskClaudeCode(a);
    case "remember":
      return runRemember(a, ctx);
    case "add_fact":
      return runAddFact(a);
    case "list_memory":
      return runListMemory(a);
    case "forget_memory":
      return runForgetMemory(a);
    case "list_facts":
      return runListFacts(a);
    case "forget_fact":
      return runForgetFact(a);
    case "mempalace_get_drawer":
      return runMempalaceGetDrawer(a);
    case "forget_session":
      return runForgetSession(a, ctx);
    case "task_complete":
      // Harness must intercept this BEFORE calling executeTool. Defensive throw.
      throw new Error(
        "task_complete is a harness stop signal, not a callable tool",
      );
    default:
      // Unreachable while isValidToolName is in sync with the switch.
      throw new Error(`Tool '${name}' is registered but has no executor`);
  }
}

// Exported path joiner for callers that want to resolve canon paths the same way.
export function canonAbsPath(
  domain: string,
  subdomain: string,
  filename: string,
): string {
  return join(CANON_ROOT, domain, subdomain, filename);
}
