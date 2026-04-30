/**
 * qwen-harness.ts
 *
 * The Qwen agent loop. One public entry point: runQwenTurn().
 *
 * Responsibilities:
 *  - Load/create per-channel session state (JSON file, atomic write, mutex)
 *  - Push user message into session
 *  - Run the tool-calling loop against qwen-client.chat()
 *  - Enforce stop conditions: task_complete (with canon-commit gate),
 *    per-tool failure cap (2), wall-clock timeout (5 min), 10-turn cap,
 *    text-only verification gate
 *  - Persist session, return RunResult
 *
 * Stubs for Team C are clearly marked below. They must match the signatures
 * listed here — Team C drops in real implementations, no harness changes.
 */

import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile, rename } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type OpenAI from "openai";

import { chat, QwenTimeoutError } from "./qwen-client.js";
import {
  TOOL_SCHEMAS,
  executeTool,
  isValidToolName,
  type ToolContext,
} from "./qwen-tools.js";
import { recall, maybeRemember } from "./qwen-memory.js";
import { readFactsAsString } from "./shared-facts.js";
import {
  isEnabled as mpEnabled,
  mpSearch,
  mpSearchAsString,
  mpAddDrawer,
  mpUpdateDrawer,
  mpGetDrawer,
  mpKgAdd,
} from "./mempalace-client.js";
import { estimateTokens } from "./token-estimate.js";
import { loadPersona, getPersonaSync, type Persona } from "./qwen-persona.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Wall-clock and per-tool-failure caps are the only loop guardrails.
// The previous MAX_TURNS_PER_USER_MESSAGE = 10 was removed: it cut productive
// long task loops mid-work. Wall-clock at 5 min still bounds hangs; per-tool
// failure cap of 2 still bounds broken tools. Total turn count is unbounded.
const WALL_CLOCK_MS = parseInt(
  process.env.QWEN_WALL_CLOCK_MS ?? String(5 * 60_000),
  10,
);
const PER_TOOL_FAILURE_CAP = 2;
const CONTEXT_SOFT_LIMIT_TOKENS = 25_000; // vLLM max_model_len is 32k; leave headroom.
// Upper bound on a persisted tool-result body in session.messages. The CURRENT
// turn still reasons over the full result via an in-memory overlay, but what
// gets stored for future-turn replay is truncated to a stub + 200-char preview.
// Raised from 1024 to 4096 so small results like list_memory (~3KB) and
// canon_search don't get pointlessly shredded for marginal byte savings —
// the stub itself is ~260 bytes, so anything under ~1500 bytes barely saves
// anything. 4096 preserves the common small results while still catching
// canon_read dumps (>10KB typical, >100KB possible).
const TOOL_RESULT_HISTORY_MAX_BYTES = 4096;
// Aggregate cap on overlay-expanded wire content per chat() call. The overlay
// holds full tool-result bodies that get substituted into `outgoing` at send
// time; compressOldMessages counts these bytes as part of the real wire cost
// (fixing the budget-divergence bug where compression measured stubs while
// vLLM received hydrated content). When the overlay exceeds this cap the
// compression pass evicts the oldest overlay entries first — the stubs stay
// in session.messages, just without their overlay-expanded full bodies.
// 60000 ≈ 15k tokens, leaving ~10k for system prompt + current turn prose
// inside the 25k soft limit.
const OVERLAY_SOFT_BYTES = 60_000;
// Layer C — rolling window. After end-of-turn fact extraction (Layer B),
// session.messages is trimmed to the most recent N user/assistant turn
// pairs. The dropped turns live on as drawers in the qwen wing and surface
// via mpSearch in the system prompt's [RELEVANT MEMORIES] block.
// 10 pairs ≈ 20 messages of verbatim history; with average turn size
// ~1500 tokens this caps the verbatim window at ~30K tokens IF tools
// haven't been promoted out. Combined with Layer A pointer replacement,
// the actual wire cost typically lands much lower.
const ROLLING_WINDOW_TURN_PAIRS = 10;
const SESSION_IDLE_MS = parseInt(
  process.env.QWEN_SESSION_IDLE_MS ?? String(30 * 60_000),
  10,
);

// Session directory lives inside claude-middleware/ (sibling of src/).
function getSessionsDir(): string {
  if (process.env.QWEN_SESSIONS_DIR) return process.env.QWEN_SESSIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/qwen-harness.ts -> ../qwen-sessions
  return path.resolve(here, "..", "qwen-sessions");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatMessage = any; // OpenAI.Chat.Completions.ChatCompletionMessageParam in practice, but we store assistant responses verbatim.

export interface QwenSession {
  id: string;
  channelId: string;
  messages: ChatMessage[];
  taskState: "idle" | "running" | "awaiting_user";
  currentTurn: number;
  /** Map serialised as Record for JSON; reset at the start of every user message. */
  toolFailures: Record<string, number>;
  hadCommitDuringThisTask: boolean;
  lastUserMessageRequestedCanon: boolean;
  /**
   * Messages-count snapshot at the last successful maybeRemember() write.
   * Used so the "every N user/assistant turns" rule fires on deltas rather
   * than exact multiples (which miss easily under varying turn shapes).
   */
  lastRememberedAtCount?: number;
  /**
   * Layer C — MemPalace drawer holding this channel's "state file" (current
   * task, open questions, recent decisions, active references). Created on
   * first turn under MEMPALACE_ENABLED, updated end-of-turn via
   * mpUpdateDrawer. Persists across middleware restarts via the session JSON.
   */
  channelStateDrawerId?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface RunResult {
  finalText: string | null;
  /** Optional explicit files to upload alongside finalText (task_complete attachments). */
  attachments?: Array<{ name: string; content: string }>;
  stopReason:
    | "task_complete"
    | "text_only"
    | "wall_clock_timeout"
    | "error";
  turns: number;
  sessionId: string;
}

// --- task_complete attachment validation ---
// Per-message Discord upload cap is 10MB decimal (10,000,000 bytes) — NOT
// binary 10 * 1024 * 1024. The 485KB difference matters: if we accept the
// binary value, Discord 413s at send time. Using decimal keeps us under
// Discord's actual wire limit.
const OUTBOUND_MAX_FILES = 5;
const OUTBOUND_MAX_BYTES = 10_000_000; // 10MB per file (decimal)
const OUTBOUND_MESSAGE_TOTAL_MAX = 10_000_000; // 10MB per Discord message (decimal)
const OUTBOUND_SUMMARY_MAX_CHARS = 1800; // matches sendWithFiles inline cap
const OUTBOUND_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const OUTBOUND_ALLOWED_EXTS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
]);

/**
 * Normalise & validate a task_complete tool call: checks the summary (must
 * be non-empty and short enough to fit inline on Discord) and the attachments
 * list (valid names, allowed extensions, per-file and per-message size caps).
 *
 * Design principle: attachments are ALWAYS explicit and ALWAYS come with a
 * human-readable explanation inline. The summary is that explanation and
 * cannot be omitted, empty, or demoted to a file. Violations throw so the
 * harness feeds the error back as a tool result and Qwen can adapt.
 */
function validateTaskComplete(
  summaryRaw: unknown,
  attachmentsRaw: unknown,
): { summary: string; attachments: Array<{ name: string; content: string }> } {
  // --- Summary validation ---
  if (typeof summaryRaw !== "string") {
    throw new Error("task_complete.summary is required and must be a string");
  }
  const summary = summaryRaw;
  if (summary.trim().length === 0) {
    throw new Error(
      "task_complete.summary must be non-empty — attachments must be preceded by an explanation",
    );
  }
  if (summary.length > OUTBOUND_SUMMARY_MAX_CHARS) {
    throw new Error(
      `task_complete.summary is ${summary.length} chars; max ${OUTBOUND_SUMMARY_MAX_CHARS} (Discord inline cap)`,
    );
  }

  // --- Attachments validation ---
  const attachments: Array<{ name: string; content: string }> = [];
  if (attachmentsRaw !== undefined && attachmentsRaw !== null) {
    if (!Array.isArray(attachmentsRaw)) {
      throw new Error("task_complete.attachments must be an array if provided");
    }
    if (attachmentsRaw.length > OUTBOUND_MAX_FILES) {
      throw new Error(
        `task_complete.attachments: too many files (${attachmentsRaw.length}); max ${OUTBOUND_MAX_FILES}`,
      );
    }
    for (let i = 0; i < attachmentsRaw.length; i++) {
      const item = attachmentsRaw[i] as { name?: unknown; content?: unknown } | null;
      if (!item || typeof item !== "object") {
        throw new Error(`task_complete.attachments[${i}] must be an object`);
      }
      const name = item.name;
      const content = item.content;
      if (typeof name !== "string" || !OUTBOUND_NAME_RE.test(name)) {
        throw new Error(
          `task_complete.attachments[${i}].name must match ${OUTBOUND_NAME_RE} (got: ${JSON.stringify(name)})`,
        );
      }
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      if (!OUTBOUND_ALLOWED_EXTS.has(ext)) {
        throw new Error(
          `task_complete.attachments[${i}].name: extension '${ext}' not allowed (allowed: ${[...OUTBOUND_ALLOWED_EXTS].join(", ")})`,
        );
      }
      if (typeof content !== "string") {
        throw new Error(
          `task_complete.attachments[${i}].content must be a string`,
        );
      }
      const bytes = Buffer.byteLength(content, "utf-8");
      if (bytes > OUTBOUND_MAX_BYTES) {
        throw new Error(
          `task_complete.attachments[${i}] '${name}': ${bytes} bytes exceeds per-file cap ${OUTBOUND_MAX_BYTES}`,
        );
      }
      attachments.push({ name, content });
    }
  }

  // --- Total message size check (summary bytes + all file bytes) ---
  const summaryBytes = Buffer.byteLength(summary, "utf-8");
  const fileBytes = attachments.reduce(
    (acc, f) => acc + Buffer.byteLength(f.content, "utf-8"),
    0,
  );
  const totalBytes = summaryBytes + fileBytes;
  if (totalBytes > OUTBOUND_MESSAGE_TOTAL_MAX) {
    throw new Error(
      `task_complete total message size ${totalBytes} bytes exceeds ${OUTBOUND_MESSAGE_TOTAL_MAX} (Discord per-message cap). Summary: ${summaryBytes}, files: ${fileBytes}.`,
    );
  }

  return { summary, attachments };
}

// ---------------------------------------------------------------------------
// Per-channel async mutex (simple promise chain)
// ---------------------------------------------------------------------------

const channelLocks = new Map<string, Promise<unknown>>();

async function withChannelLock<T>(
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Chain this turn after the previous one for the same channel. We wrap
  // prev in `.catch(() => {})` so a rejected predecessor doesn't poison
  // the whole chain for subsequent waiters.
  const prev = channelLocks.get(channelId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => {
    release = res;
  });
  // CRITICAL: capture the chained promise in a local so the `===` identity
  // check in finally actually works. Previously we called `prev.then(...)`
  // twice — which creates two distinct Promise objects — so the cleanup
  // comparison was structurally impossible and the Map leaked forever.
  const tail = prev.catch(() => {}).then(() => next);
  channelLocks.set(channelId, tail);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    // Drop the map entry only if we're still the tail (i.e. no one else
    // chained behind us while fn() was running).
    if (channelLocks.get(channelId) === tail) {
      channelLocks.delete(channelId);
    }
  }
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

async function loadSession(channelId: string): Promise<QwenSession | null> {
  const file = path.join(getSessionsDir(), `${channelId}.json`);
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as QwenSession;
    return parsed;
  } catch {
    return null;
  }
}

function createSession(channelId: string): QwenSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    channelId,
    messages: [],
    taskState: "idle",
    currentTurn: 0,
    toolFailures: {},
    hadCommitDuringThisTask: false,
    lastUserMessageRequestedCanon: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function saveSession(session: QwenSession): Promise<void> {
  const dir = getSessionsDir();
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${session.channelId}.json.tmp`);
  const final = path.join(dir, `${session.channelId}.json`);
  session.updatedAt = new Date().toISOString();
  await writeFile(tmp, JSON.stringify(session, null, 2), "utf-8");
  await rename(tmp, final);
}

/**
 * Move the current session file (if any) to an archive with a timestamped
 * name. Idempotent: a missing session file is a no-op. Used by the
 * `reset:` directive and by the idle-timeout path in runQwenTurn.
 */
export async function maybeArchiveSession(channelId: string): Promise<boolean> {
  const dir = getSessionsDir();
  const src = path.join(dir, `${channelId}.json`);
  try {
    // stat as a cheap existence check; readFile would also work.
    const raw = await readFile(src, "utf-8");
    const archiveDir = path.join(dir, "archive");
    await mkdir(archiveDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(archiveDir, `${channelId}_${ts}.json`);
    await writeFile(dest, raw, "utf-8");
    // Delete the original by overwriting with empty then unlinking. Simpler:
    // use rename to a sentinel path inside archive, then we don't need
    // a separate unlink. Above we already copied, so unlink the source.
    const { unlink } = await import("fs/promises");
    await unlink(src);
    console.log(
      `[qwen-harness] archived session for channel ${channelId} → ${dest}`,
    );
    return true;
  } catch {
    // No session to archive; not an error.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANON_KEYWORD_RE =
  /\b(canon|commit|write|draft|scene|lore|bestiary|resistance|world_bible|faction|technology|facility_ops|hackers_shift)\b/i;

export function looksLikeCanonRequest(text: string): boolean {
  return CANON_KEYWORD_RE.test(text);
}

/**
 * Produce a compact stub representation of an oversized tool result so it can
 * be persisted into session.messages without dominating the context budget.
 * Format:
 *   [<toolName> result truncated: <N> bytes total. Preview: <first 200 chars>...]
 * The full result is still handed to Qwen on the immediately-following chat()
 * call via an in-memory overlay keyed by tool_call_id; only the persisted
 * (future-turn replay) copy is shrunk.
 */
function truncateToolResultForHistory(
  toolName: string,
  fullContent: string,
): string {
  const bytes = Buffer.byteLength(fullContent, "utf-8");
  // Collapse whitespace in the preview so newline/indent noise doesn't eat
  // most of the 200-char budget. We intentionally keep this simple — the
  // preview is a hint for a replaying agent, not a reconstruction.
  const previewRaw = fullContent.slice(0, 200);
  const preview = previewRaw.replace(/\s+/g, " ").trim();
  return `[${toolName} result truncated: ${bytes} bytes total. Preview: ${preview}...]`;
}

/**
 * Layer A — Memory pointer pattern. When MEMPALACE_ENABLED and a large
 * tool result is being evicted from the overlay, promote it to a drawer
 * and return a structured pointer the model can re-fetch via
 * mempalace_get_drawer. Falls back to a prose stub on failure.
 */
function buildToolResultPointer(opts: {
  toolName: string;
  drawerId: string;
  channelId: string;
  bytes: number;
  preview: string;
}): string {
  const { toolName, drawerId, channelId, bytes, preview } = opts;
  return JSON.stringify({
    _kind: "tool_result_pointer",
    tool: toolName,
    drawer_id: drawerId,
    wing: "qwen",
    room: "tool_results",
    channel: channelId,
    size_bytes: bytes,
    preview: preview.slice(0, 240),
    note:
      "Full body in MemPalace. Call mempalace_get_drawer with this drawer_id to re-read.",
  });
}

// Persona is cached with a TTL inside qwen-persona.ts, so we can safely
// call loadPersona() every turn — it only touches disk when the TTL has
// expired AND an mtime has changed. This lets SOUL.md / MEMORY.md edits
// propagate without a middleware restart.
function ensurePersona(): Promise<Persona> {
  return loadPersona();
}

// ---------------------------------------------------------------------------
// Layer C — Channel state file (Anthropic memory-tool pattern)
// ---------------------------------------------------------------------------

/**
 * Build the channel state markdown from the live session. Inspects the
 * recent message tail to extract:
 *   - Current task: latest task_complete summary (if any)
 *   - Recent decisions: last canon_commit results in tail
 *   - Active references: drawer_ids from any tool_result_pointer messages
 *
 * Open questions are NOT auto-extracted in v1 — Layer B fact extraction
 * may surface them later. Returns markdown ≤ ~2000 chars.
 */
function buildChannelStateMarkdown(session: QwenSession): string {
  const lines: string[] = [];
  lines.push(`# Channel ${session.channelId} — Active State (auto-managed)`);
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push("");

  // --- Current task ---
  let currentTask = "(none — awaiting next user request)";
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i] as { role?: string; tool_calls?: any[] };
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      const tc = m.tool_calls.find(
        (c: any) => c?.function?.name === "task_complete",
      );
      if (tc?.function?.arguments) {
        try {
          const parsed = JSON.parse(tc.function.arguments);
          if (typeof parsed?.summary === "string") {
            currentTask = parsed.summary.slice(0, 400);
            break;
          }
        } catch {
          // Ignore parse errors.
        }
      }
    }
  }
  lines.push("## Current task");
  lines.push(currentTask);
  lines.push("");

  // --- Recent decisions (last 5 canon commits) ---
  const decisions: string[] = [];
  for (let i = session.messages.length - 1; i >= 0 && decisions.length < 5; i--) {
    const m = session.messages[i] as {
      role?: string;
      tool_call_id?: string;
      content?: string;
    };
    if (m?.role === "tool" && typeof m.content === "string") {
      // canon_commit results have a recognisable shape — look for branch + commit
      try {
        const parsed = JSON.parse(m.content);
        if (parsed?.branch && parsed?.commit_hash) {
          decisions.unshift(
            `- ${parsed.branch}@${String(parsed.commit_hash).slice(0, 8)}: ${(parsed.message ?? "").slice(0, 80)}`,
          );
        }
      } catch {
        // Not JSON or not a commit result — skip.
      }
    }
  }
  if (decisions.length > 0) {
    lines.push("## Recent decisions");
    lines.push(...decisions);
    lines.push("");
  }

  // --- Active references (tool_result_pointer drawers) ---
  const refs: string[] = [];
  for (const m of session.messages) {
    const msg = m as { role?: string; content?: string };
    if (msg?.role !== "tool" || typeof msg.content !== "string") continue;
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed?._kind === "tool_result_pointer" && parsed.drawer_id) {
        refs.push(
          `- ${parsed.drawer_id} (${parsed.tool}, ${parsed.size_bytes}B) — ${(parsed.preview ?? "").slice(0, 80)}`,
        );
      }
    } catch {
      // Ignore.
    }
  }
  if (refs.length > 0) {
    lines.push("## Active references");
    lines.push("Use mempalace_get_drawer to re-read these on demand:");
    lines.push(...refs.slice(0, 10)); // cap at 10 to stay terse
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Save channel state to MemPalace. Creates the drawer on first call (storing
 * the id back to session.channelStateDrawerId), updates in-place thereafter.
 * No-op when MEMPALACE_ENABLED is false.
 */
async function saveChannelState(session: QwenSession): Promise<void> {
  if (!mpEnabled()) return;
  try {
    const md = buildChannelStateMarkdown(session);
    if (session.channelStateDrawerId) {
      const result = await mpUpdateDrawer(session.channelStateDrawerId, {
        content: md,
      });
      if (!result.success) {
        // Drawer may have been deleted externally — fall through to recreate.
        console.warn(
          `[qwen-harness] channel_state update failed (${result.error}); recreating drawer`,
        );
        session.channelStateDrawerId = undefined;
      } else {
        return;
      }
    }
    const created = await mpAddDrawer("qwen", "channel_state", md, {
      added_by: "qwen-harness",
      source_file: `channel:${session.channelId}:state`,
    });
    if (created.success && created.drawer_id) {
      session.channelStateDrawerId = created.drawer_id;
    }
  } catch (err: any) {
    console.error(`[qwen-harness] saveChannelState failed: ${err?.message ?? err}`);
  }
}

/**
 * Load channel state markdown for the system prompt. Returns "" if not
 * available (no MemPalace, no drawer yet, or fetch failed).
 */
async function loadChannelState(session: QwenSession): Promise<string> {
  if (!mpEnabled() || !session.channelStateDrawerId) return "";
  try {
    const result = await mpGetDrawer(session.channelStateDrawerId);
    if (result.error || !result.drawer) return "";
    return result.drawer.text ?? "";
  } catch (err: any) {
    console.error(`[qwen-harness] loadChannelState failed: ${err?.message ?? err}`);
    return "";
  }
}

/**
 * Layer B — Write-time fact extraction. Parses the optional `facts` array
 * from a task_complete tool call's arguments and writes each fact as a
 * focused MemPalace drawer in wing="qwen", room=fact.type. Optionally adds
 * a KG triple when fact.kg_triple is present.
 *
 * Tolerant of bad input: each fact is validated independently; one bad
 * fact doesn't block the others. No-op when MEMPALACE_ENABLED is false.
 *
 * Returns the number of drawers actually written.
 */
async function writeExtractedFacts(
  facts: unknown,
  session: QwenSession,
): Promise<number> {
  if (!mpEnabled() || !Array.isArray(facts) || facts.length === 0) return 0;
  const allowedTypes = new Set([
    "decision",
    "naming",
    "user_preference",
    "canon_observation",
  ]);
  let written = 0;
  for (const f of facts.slice(0, 8)) {
    const fact = f as {
      type?: unknown;
      content?: unknown;
      kg_triple?: { subject?: unknown; predicate?: unknown; object?: unknown; valid_from?: unknown };
    };
    if (
      typeof fact.type !== "string" ||
      !allowedTypes.has(fact.type) ||
      typeof fact.content !== "string" ||
      fact.content.trim().length === 0 ||
      fact.content.length > 500
    ) {
      console.warn(
        `[qwen-harness.writeExtractedFacts] skipping malformed fact: ${JSON.stringify(fact).slice(0, 120)}`,
      );
      continue;
    }
    try {
      const result = await mpAddDrawer("qwen", fact.type, fact.content, {
        added_by: "qwen-fact-extract",
        source_file: `channel:${session.channelId}`,
      });
      if (result.success) written++;
      else console.warn(`[qwen-harness.writeExtractedFacts] add failed: ${result.error}`);

      // Optional KG triple write.
      const tr = fact.kg_triple;
      if (
        tr &&
        typeof tr.subject === "string" &&
        typeof tr.predicate === "string" &&
        typeof tr.object === "string" &&
        tr.subject.length <= 128 &&
        tr.predicate.length <= 128 &&
        tr.object.length <= 128
      ) {
        const validFrom =
          typeof tr.valid_from === "string" ? tr.valid_from : undefined;
        await mpKgAdd(tr.subject, tr.predicate, tr.object, validFrom);
      }
    } catch (err: any) {
      console.error(
        `[qwen-harness.writeExtractedFacts] threw on '${fact.type}': ${err?.message ?? err}`,
      );
    }
  }
  if (written > 0) {
    console.log(
      `[qwen-harness.writeExtractedFacts] wrote ${written}/${facts.length} extracted facts to qwen wing`,
    );
  }
  return written;
}

/**
 * Layer C — Rolling window. After fact extraction at end-of-turn, drop
 * old user/assistant turn pairs from session.messages so the verbatim
 * window stays bounded. Counts user messages: keep the latest N, drop
 * everything before the (N+1)-th user message from the end.
 *
 * Tool messages get dropped as a side effect (they're between the user
 * messages we drop). Their drawer-promoted content (Layer A) survives.
 *
 * No-op when MEMPALACE_ENABLED is false (the old compression in
 * compressOldMessages still applies).
 */
function applyRollingWindow(session: QwenSession): void {
  if (!mpEnabled()) return;
  const userIdxs: number[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    if ((session.messages[i] as { role?: string })?.role === "user") {
      userIdxs.push(i);
    }
  }
  if (userIdxs.length <= ROLLING_WINDOW_TURN_PAIRS) return;
  // Keep the latest ROLLING_WINDOW_TURN_PAIRS user messages and everything
  // after them. Drop everything before the (count - N)-th user message.
  const dropBeforeUserIdx = userIdxs[userIdxs.length - ROLLING_WINDOW_TURN_PAIRS]!;
  const dropped = session.messages.splice(0, dropBeforeUserIdx);
  console.log(
    `[qwen-harness.applyRollingWindow] dropped ${dropped.length} pre-window messages; ${session.messages.length} remain`,
  );
}

function buildSystemPrompt(opts: {
  persona: Persona;
  memories: string[];
  facts: string;
  channelState: string;
  tools: OpenAI.Chat.Completions.ChatCompletionFunctionTool[];
}): string {
  const { persona, memories, facts, channelState, tools } = opts;

  const memBlock = memories.length
    ? `[RELEVANT MEMORIES]\n${memories.map((m) => `- ${m}`).join("\n")}`
    : "";
  const factBlock = facts.trim() ? `[SHARED FACTS]\n${facts.trim()}` : "";
  const stateBlock = channelState.trim()
    ? `[CHANNEL STATE]\n${channelState.trim()}`
    : "";

  const toolList = tools
    .map((t) => `- ${t.function.name}: ${t.function.description ?? ""}`)
    .join("\n");

  // Layer D — layered system prompt mirroring MemPalace's L0/L1/L2/L3:
  //   IDENTITY / VOICE / STATIC MEMORY  → L0 persona (always)
  //   CHANNEL STATE                     → L1 channel-scoped working memory
  //   SHARED FACTS / RELEVANT MEMORIES  → L2 retrieval (filtered drawers)
  //   tools + instructions              → action surface
  // Channel state is placed near the top so it strongly anchors the model
  // on the current task; older drawers via search appear lower-priority.
  const instructionsBlock = `[INSTRUCTIONS]
- Reason step by step before calling tools.
- Call tools when you need info or to take action.
- When done, call task_complete(summary). If you learned durable facts this turn (decisions, naming, user preferences, canon facts), include them in the optional \`facts\` array — the middleware will store them in MemPalace so future turns recall them.
- If a tool fails twice in a row, stop calling it and try a different approach or ask the user.
- Never fabricate tool results — only use what a tool actually returned.
- Keep your final summary concise.
- LARGE TOOL RESULTS: when a prior tool result in your history shows JSON with \`_kind: "tool_result_pointer"\` and a \`drawer_id\`, that means the full body was promoted to MemPalace. Use \`mempalace_get_drawer\` with that drawer_id to re-read it on demand. Do NOT re-run the original tool unless the underlying data may have changed.
- INFINITE CONVERSATION: pre-window turn pairs are dropped from your verbatim history but live on as MemPalace drawers. If you need a fact from earlier, use \`mempalace_search\` first; \`mempalace_get_drawer\` second.`;

  return [
    `[IDENTITY]\n${persona.identity.trim()}`,
    `[VOICE AND VALUES]\n${persona.soul.trim()}`,
    `[STATIC MEMORY]\n${persona.memory.trim()}`,
    stateBlock,
    factBlock,
    memBlock,
    `[AVAILABLE TOOLS]\n${toolList}`,
    instructionsBlock,
  ]
    .filter((s) => s && s.length > 0)
    .join("\n\n");
}

/**
 * Rolling truncation that accounts for both persisted session.messages AND
 * the in-memory tool-result overlay. The overlay holds full tool-result
 * bodies that get hydrated into `outgoing` at send time; compression must
 * count those bytes because the wire cost (to vLLM) is the hydrated form,
 * not the stubbed `session.messages` form.
 *
 * Eviction order (cheapest semantic loss first):
 *   1. Drop the oldest overlay entries. The matching stub stays in
 *      session.messages — Qwen loses the ability to reason over the full
 *      prior tool result but still sees the preview + byte count.
 *   2. Only if dropping ALL overlay entries still leaves us over the soft
 *      limit, fall through to dropping whole turn groups (oldest first).
 *
 * The LAST turn group (containing the latest user message) is always
 * preserved, even if it alone exceeds the soft limit.
 *
 * This replaces the earlier bug where compression measured `session.messages`
 * byte cost (stubs) while vLLM received the overlay-hydrated wire payload.
 * That divergence let the "soft limit" pass while the real request exceeded
 * max_model_len, producing sporadic vLLM 400s on tool-heavy user messages.
 */
export async function compressOldMessages(
  session: QwenSession,
  systemPrompt: string,
  overlay: Map<string, string>,
): Promise<void> {
  // Layer A — memory pointer pattern. When evicting an overlay entry, promote
  // it to a MemPalace drawer first (if MEMPALACE_ENABLED) and rewrite the
  // corresponding session.messages stub into a structured pointer the model
  // can re-fetch via mempalace_get_drawer.
  const promoteEvicted = async (toolCallId: string): Promise<void> => {
    if (!mpEnabled()) return;
    const body = overlay.get(toolCallId);
    if (!body) return;
    // Find the matching tool message in session.messages to extract the
    // tool name (which we need for the pointer payload).
    let toolName = "unknown_tool";
    let stubMsg: { role?: string; tool_call_id?: string; content?: string } | undefined;
    for (const m of session.messages) {
      const msg = m as { role?: string; tool_call_id?: string; content?: string };
      if (msg?.role === "tool" && msg.tool_call_id === toolCallId) {
        stubMsg = msg;
        // Try to recover tool name from the existing stub. truncateToolResultForHistory
        // formats it as `[<toolName> result truncated: ...`. If the stub is already
        // a structured pointer (re-eviction), parse the JSON.
        const c = msg.content ?? "";
        const stubMatch = /^\[([a-z_]+)\s+result\s+truncated/i.exec(c);
        if (stubMatch && stubMatch[1]) {
          toolName = stubMatch[1];
        } else {
          try {
            const parsed = JSON.parse(c);
            if (parsed?._kind === "tool_result_pointer" && typeof parsed.tool === "string") {
              toolName = parsed.tool;
            }
          } catch {
            // Not JSON — keep "unknown_tool".
          }
        }
        break;
      }
    }
    try {
      const result = await mpAddDrawer("qwen", "tool_results", body, {
        added_by: "qwen-harness-evict",
        source_file: `channel:${session.channelId}|tool_call:${toolCallId}`,
      });
      if (result.success && result.drawer_id && stubMsg) {
        const previewRaw = body.slice(0, 240);
        const preview = previewRaw.replace(/\s+/g, " ").trim();
        stubMsg.content = buildToolResultPointer({
          toolName,
          drawerId: result.drawer_id,
          channelId: session.channelId,
          bytes: Buffer.byteLength(body, "utf-8"),
          preview,
        });
        console.log(
          `[qwen-harness.compressOldMessages] Layer A promoted overlay[${toolCallId}] → drawer ${result.drawer_id}`,
        );
      } else if (!result.success) {
        console.warn(
          `[qwen-harness.compressOldMessages] Layer A promotion failed for ${toolCallId}: ${result.error}`,
        );
      }
    } catch (err: any) {
      console.error(
        `[qwen-harness.compressOldMessages] Layer A promotion threw: ${err?.message ?? err}`,
      );
    }
  };

  // Build the set of tool_call_ids CURRENTLY referenced by session.messages.
  // Overlay entries whose id is no longer in session.messages are orphans
  // from a prior compression pass; drop them unconditionally.
  const refreshLiveIds = (): Set<string> => {
    const live = new Set<string>();
    for (const m of session.messages) {
      const msg = m as { role?: string; tool_call_id?: string };
      if (msg?.role === "tool" && typeof msg.tool_call_id === "string") {
        live.add(msg.tool_call_id);
      }
    }
    return live;
  };

  const pruneOrphans = () => {
    const live = refreshLiveIds();
    for (const key of Array.from(overlay.keys())) {
      if (!live.has(key)) overlay.delete(key);
    }
  };

  // Estimate the wire cost: stubs in session.messages PLUS the overlay's
  // contribution (each live overlay entry replaces the stub's content at
  // send time, so we need overlay_bytes - stub_bytes more than the stubbed
  // count — approximate as overlay_bytes since stubs are small).
  const estimateWire = (): number => {
    let text = systemPrompt;
    for (const m of session.messages) text += JSON.stringify(m);
    // Add overlay bytes for entries still referenced. Dead orphans get
    // pruned before estimation.
    const live = refreshLiveIds();
    for (const [id, content] of overlay.entries()) {
      if (live.has(id)) {
        // Rough overestimate: the overlay replaces the stub content, but
        // we add the full overlay length since the wire form sends it.
        text += content;
      }
    }
    return estimateTokens(text);
  };

  pruneOrphans();

  // Stage 1 helper: walk session.messages in order, return tool_call_ids
  // that are present in the overlay. "Oldest" = earliest position in
  // session.messages. Used by the aggregate pre-filter AND the full-budget
  // eviction loop.
  const orderedOverlayIds = (): string[] => {
    const ids: string[] = [];
    for (const m of session.messages) {
      const msg = m as { role?: string; tool_call_id?: string };
      if (
        msg?.role === "tool" &&
        typeof msg.tool_call_id === "string" &&
        overlay.has(msg.tool_call_id)
      ) {
        ids.push(msg.tool_call_id);
      }
    }
    return ids;
  };

  // Stage 0 — Aggregate overlay size pre-filter. OVERLAY_SOFT_BYTES caps
  // the TOTAL bytes held in the overlay regardless of the wire-cost estimate,
  // so a burst of large tool calls in one user message can't accumulate
  // arbitrarily. Cheap O(n) check that short-circuits the more expensive
  // tiktoken-based Stage 1 loop on big-overlay scenarios.
  const overlayTotalBytes = (): number => {
    let n = 0;
    for (const v of overlay.values()) n += Buffer.byteLength(v, "utf-8");
    return n;
  };
  let evictedForSoftBytes = 0;
  while (overlayTotalBytes() > OVERLAY_SOFT_BYTES) {
    const ordered = orderedOverlayIds();
    if (ordered.length === 0) break;
    const victim = ordered[0]!;
    const victimBytes = Buffer.byteLength(overlay.get(victim) ?? "", "utf-8");
    await promoteEvicted(victim);
    overlay.delete(victim);
    evictedForSoftBytes++;
    console.log(
      `[qwen-harness.compressOldMessages] Stage 0 evict overlay[${victim}] (${victimBytes}B) — overlay soft cap ${OVERLAY_SOFT_BYTES}B`,
    );
  }

  if (estimateWire() <= CONTEXT_SOFT_LIMIT_TOKENS) {
    if (evictedForSoftBytes > 0) {
      console.log(
        `[qwen-harness.compressOldMessages] Stage 0 drained overlay by ${evictedForSoftBytes} entr${evictedForSoftBytes === 1 ? "y" : "ies"}; now under soft limit`,
      );
    }
    return;
  }

  // Stage 1: evict oldest overlay entries until the wire estimate is
  // under the token soft limit.
  let evictedForTokens = 0;
  while (estimateWire() > CONTEXT_SOFT_LIMIT_TOKENS) {
    const ordered = orderedOverlayIds();
    if (ordered.length === 0) break;
    const victim = ordered[0]!;
    const victimBytes = Buffer.byteLength(overlay.get(victim) ?? "", "utf-8");
    await promoteEvicted(victim);
    overlay.delete(victim);
    evictedForTokens++;
    console.log(
      `[qwen-harness.compressOldMessages] Stage 1 evict overlay[${victim}] (${victimBytes}B) — wire estimate over ${CONTEXT_SOFT_LIMIT_TOKENS} tokens`,
    );
  }
  if (estimateWire() <= CONTEXT_SOFT_LIMIT_TOKENS) {
    console.log(
      `[qwen-harness.compressOldMessages] Stage 0+1 evicted ${evictedForSoftBytes + evictedForTokens} overlay entr${evictedForSoftBytes + evictedForTokens === 1 ? "y" : "ies"}; now under soft limit`,
    );
    return;
  }

  // Stage 2: still over budget with zero overlay entries. Drop whole turn
  // groups from the oldest (user-message seam) boundary.
  const userIdxs: number[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    if ((session.messages[i] as { role?: string })?.role === "user") {
      userIdxs.push(i);
    }
  }
  // Nothing to drop if we have 0 or 1 user messages — compression would
  // break the latest turn group.
  let droppedGroups = 0;
  while (estimateWire() > CONTEXT_SOFT_LIMIT_TOKENS && userIdxs.length > 1) {
    const nextUserStart = userIdxs[1]!;
    const dropCount = nextUserStart;
    session.messages.splice(0, dropCount);
    droppedGroups++;
    console.log(
      `[qwen-harness.compressOldMessages] Stage 2 dropped turn group (${dropCount} messages); ${session.messages.length} remain`,
    );
    // Recompute seams after splice.
    userIdxs.length = 0;
    for (let i = 0; i < session.messages.length; i++) {
      if ((session.messages[i] as { role?: string })?.role === "user") {
        userIdxs.push(i);
      }
    }
    // Prune any overlay entries orphaned by the splice.
    pruneOrphans();
  }
  if (droppedGroups > 0) {
    console.log(
      `[qwen-harness.compressOldMessages] Stage 2 total: ${droppedGroups} turn group(s) dropped`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runQwenTurn(
  channelId: string,
  userMessage: string,
): Promise<RunResult> {
  return withChannelLock(channelId, async () => {
    // Idle session reset: if the persisted session hasn't been updated in
    // longer than SESSION_IDLE_MS (default 30min), archive it and start
    // fresh. Prevents yesterday's goblin context from polluting today's
    // cat conversation.
    const existing = await loadSession(channelId);
    let session: QwenSession;
    if (existing) {
      const idleMs =
        Date.now() - new Date(existing.updatedAt ?? existing.createdAt).getTime();
      if (idleMs > SESSION_IDLE_MS) {
        console.log(
          `[qwen-harness] session for ${channelId} idle ${Math.round(idleMs / 1000)}s > ${Math.round(SESSION_IDLE_MS / 1000)}s — archiving and starting fresh`,
        );
        await maybeArchiveSession(channelId);
        session = createSession(channelId);
      } else {
        session = existing;
      }
    } else {
      session = createSession(channelId);
    }

    // Fresh user message: reset per-message counters.
    session.messages.push({ role: "user", content: userMessage });
    session.currentTurn = 0;
    session.toolFailures = {};
    session.hadCommitDuringThisTask = false;
    session.lastUserMessageRequestedCanon = looksLikeCanonRequest(userMessage);
    session.taskState = "running";

    const startedAt = Date.now();
    const ctx: ToolContext = {
      channelId,
      sessionId: session.id,
    };

    // In-memory overlay: tool_call_id -> full (untruncated) tool result body.
    // Populated when a large tool result is pushed to session.messages in a
    // truncated form; consumed when building `outgoing` so the live chat()
    // call still reasons over the full payload. Scoped to this runQwenTurn
    // invocation — after this user message completes, the only artifact that
    // survives is the truncated stub in session.messages.
    const toolResultOverlay = new Map<string, string>();

    let result: RunResult = {
      finalText: null,
      stopReason: "error",
      turns: 0,
      sessionId: session.id,
    };

    try {
      // Unbounded turns. The loop only exits via task_complete, text_only,
      // wall-clock timeout, or an unhandled exception. There is intentionally
      // no per-message turn cap — if Qwen needs 30 tool calls to finish a
      // job, it gets 30 tool calls. Wall-clock and per-tool failure caps
      // are the safety nets.
      loop: while (true) {
        if (Date.now() - startedAt > WALL_CLOCK_MS) {
          result = {
            finalText:
              "Qwen hit the 5-minute wall-clock limit on this turn. Pausing for user guidance.",
            stopReason: "wall_clock_timeout",
            turns: session.currentTurn,
            sessionId: session.id,
          };
          session.taskState = "awaiting_user";
          break;
        }

        // Gather context: persona + shared facts + vector recall + Layer C state.
        const persona = await ensurePersona();
        const memories = mpEnabled()
          ? (await mpSearch(userMessage, { wing: "qwen", limit: 3 })).map((r) => r.text)
          : await recall(channelId, userMessage, 3, 1500);
        const facts = mpEnabled()
          ? await mpSearchAsString("", { wing: "shared", limit: 10, maxChars: 1500 })
          : await readFactsAsString(1500);
        const channelState = await loadChannelState(session);
        const systemPrompt = buildSystemPrompt({
          persona,
          memories,
          facts,
          channelState,
          tools: TOOL_SCHEMAS,
        });

        await compressOldMessages(session, systemPrompt, toolResultOverlay);

        // Build outgoing message list. For any tool message whose tool_call_id
        // has a full-content entry in the overlay, substitute the full payload
        // so Qwen reasons over the complete result on the immediately-following
        // chat() call. The session.messages copy stays truncated for history.
        const outgoing: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...session.messages.map((m) => {
            const msg = m as { role?: string; tool_call_id?: string };
            if (
              msg?.role === "tool" &&
              typeof msg.tool_call_id === "string" &&
              toolResultOverlay.has(msg.tool_call_id)
            ) {
              return {
                ...m,
                content: toolResultOverlay.get(msg.tool_call_id)!,
              };
            }
            return m;
          }),
        ];

        let response;
        try {
          response = await chat(outgoing, TOOL_SCHEMAS);
        } catch (err) {
          if (err instanceof QwenTimeoutError) {
            // vLLM hung past the configured per-request timeout. Surface a
            // clean stop so the channel mutex releases and the user sees a
            // real error instead of a silently-wedged bot.
            result = {
              finalText: `Qwen request timed out: ${err.message}. Try again or check vLLM.`,
              stopReason: "error",
              turns: session.currentTurn,
              sessionId: session.id,
            };
            session.taskState = "awaiting_user";
            break loop;
          }
          throw err;
        }
        const assistantMsg = response.choices[0]?.message;
        if (!assistantMsg) {
          throw new Error("Qwen returned no choices");
        }

        // Persist the assistant turn verbatim so the next iteration sees its
        // tool_calls ids etc.
        session.messages.push(assistantMsg);

        const toolCalls = assistantMsg.tool_calls ?? [];

        if (toolCalls.length === 0) {
          // Text-only response.
          const textOnly = typeof assistantMsg.content === "string"
            ? assistantMsg.content
            : Array.isArray(assistantMsg.content)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? (assistantMsg.content as any[])
                  .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
                  .join("")
              : "";

          if (
            session.lastUserMessageRequestedCanon &&
            !session.hadCommitDuringThisTask
          ) {
            // Push back into the loop ONCE — the text-only gate.
            session.messages.push({
              role: "user",
              content:
                "You produced a text-only response but the task asked for canon work and you did not call canon_commit. Commit your work now or call task_complete with an explanation.",
            });
            // Clear the flag so we don't push back a second time in a row.
            session.lastUserMessageRequestedCanon = false;
            session.currentTurn += 1;
            continue;
          }

          result = {
            finalText: textOnly || null,
            stopReason: "text_only",
            turns: session.currentTurn,
            sessionId: session.id,
          };
          session.taskState = "awaiting_user";
          break;
        }

        // Execute tool calls sequentially.
        for (const call of toolCalls) {
          if (call.type !== "function") {
            // Custom tools aren't supported in this harness.
            session.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `ERROR: unsupported tool call type '${call.type}'`,
            });
            continue;
          }

          const name = call.function.name;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let args: any = {};
          try {
            args = call.function.arguments
              ? JSON.parse(call.function.arguments)
              : {};
          } catch {
            session.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `ERROR: could not parse tool arguments as JSON: ${call.function.arguments}`,
            });
            continue;
          }

          // Intercept task_complete BEFORE executeTool sees it.
          if (name === "task_complete") {
            if (
              session.lastUserMessageRequestedCanon &&
              !session.hadCommitDuringThisTask
            ) {
              session.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content:
                  "Refused: you marked the task complete but never called canon_commit. Commit your work first.",
              });
              // Clear the flag so we don't bounce forever.
              session.lastUserMessageRequestedCanon = false;
              continue;
            }
            // Validate summary + attachments together. A non-empty summary
            // is REQUIRED — attachments must always be preceded by a human-
            // readable explanation. On validation failure, push the error
            // back as a tool result so Qwen can fix and retry.
            let validated: {
              summary: string;
              attachments: Array<{ name: string; content: string }>;
            };
            try {
              validated = validateTaskComplete(args?.summary, args?.attachments);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              session.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `ERROR: ${msg}`,
              });
              continue;
            }
            // Layer B — fact extraction. The optional `facts` array on
            // task_complete carries durable facts Qwen extracted this turn.
            // Write them as drawers (and KG triples where structured) so
            // they're recallable across the rolling-window boundary.
            // Best-effort: extraction failures don't block task completion.
            try {
              await writeExtractedFacts(args?.facts, session);
            } catch (err) {
              console.warn(
                `[qwen-harness] writeExtractedFacts threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            result = {
              finalText: validated.summary,
              attachments:
                validated.attachments.length > 0 ? validated.attachments : undefined,
              stopReason: "task_complete",
              turns: session.currentTurn,
              sessionId: session.id,
            };
            session.taskState = "awaiting_user";
            break loop;
          }

          if (!isValidToolName(name)) {
            session.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `ERROR: unknown tool '${name}'`,
            });
            continue;
          }

          // Honour per-tool failure cap BEFORE the attempt — once a tool
          // has hit the cap this turn, keep refusing it so Qwen has to adapt.
          const priorFails = session.toolFailures[name] ?? 0;
          if (priorFails >= PER_TOOL_FAILURE_CAP) {
            session.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Tool ${name} already failed ${priorFails} times this turn. Stop calling it.`,
            });
            continue;
          }

          try {
            const toolResult = await executeTool(name, args, ctx);
            if (name === "canon_commit") {
              session.hadCommitDuringThisTask = true;
            }
            session.toolFailures[name] = 0;
            // Large tool results (e.g. canon_read dumping 100KB) would bloat
            // session.messages and blow the vLLM context budget on replay in
            // future turns. Persist a truncated stub to history and stash the
            // full body in the per-invocation overlay so the immediately
            // following chat() call still sees the complete payload.
            // Coerce non-strings via JSON.stringify so a future executor
            // that accidentally returns an object doesn't land in session
            // history as the literal "[object Object]" (which String() would
            // produce). TypeScript enforces string returns today; this is
            // defense against drift. The `?? ""` guards against
            // JSON.stringify(undefined) === undefined and
            // JSON.stringify(() => {}) === undefined — a subsequent
            // Buffer.byteLength(undefined) would throw TypeError.
            const resultStr =
              typeof toolResult === "string"
                ? toolResult
                : (JSON.stringify(toolResult) ?? "");
            const resultBytes = Buffer.byteLength(resultStr, "utf-8");
            if (resultBytes > TOOL_RESULT_HISTORY_MAX_BYTES) {
              // Collision handling: if vLLM ever reuses a tool_call_id (not
              // observed, but theoretically possible), we overwrite with the
              // newer body and log. Rationale: "keep older" caused BOTH the
              // older and newer tool messages in session.messages to render
              // with the OLDER overlay content at substitution time
              // (line 644-652), which meant the newer turn's reasoning saw
              // stale data. Overwrite-and-warn gives "latest wins" semantics
              // that match the user's mental model and surfaces the
              // anomaly via the log line.
              if (toolResultOverlay.has(call.id)) {
                console.warn(
                  `[qwen-harness] tool_call_id collision for ${call.id}; overwriting with newer body (latest wins)`,
                );
              }
              toolResultOverlay.set(call.id, resultStr);
              session.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: truncateToolResultForHistory(name, resultStr),
              });
            } else {
              session.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: resultStr,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const fails = priorFails + 1;
            session.toolFailures[name] = fails;
            if (fails >= PER_TOOL_FAILURE_CAP) {
              session.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `Tool ${name} failed twice in a row: ${msg}. Stop calling it. Try a different approach or ask the user.`,
              });
            } else {
              session.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `ERROR: ${msg}`,
              });
            }
          }
        }

        session.currentTurn += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        finalText: `Qwen harness error: ${msg}`,
        stopReason: "error",
        turns: session.currentTurn,
        sessionId: session.id,
      };
      session.taskState = "awaiting_user";
    }

    try {
      if (mpEnabled()) {
        // MemPalace path: write recent context to qwen wing
        // (Layer B will replace this with structured fact extraction)
        const turnCount = session.messages.filter(
          (m: any) => m && (m.role === "user" || m.role === "assistant"),
        ).length;
        const since = session.lastRememberedAtCount ?? 0;
        const delta = turnCount - since;
        if (session.hadCommitDuringThisTask || delta >= 5) {
          const relevant: any[] = [];
          for (let i = session.messages.length - 1; i >= 0 && relevant.length < 6; i--) {
            const m = session.messages[i];
            if (m && (m.role === "user" || m.role === "assistant")) relevant.unshift(m);
          }
          const parts = relevant.map((m: any) => {
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            return `${m.role}: ${c}`;
          });
          const summary = parts.join("\n\n").slice(0, 800);
          if (summary.trim().length > 0) {
            await mpAddDrawer("qwen", "context", summary, { added_by: "qwen-auto" });
            session.lastRememberedAtCount = turnCount;
          }
        }
      } else {
        await maybeRemember(session);
      }
    } catch (err) {
      console.warn(`qwen-harness: maybeRemember failed: ${err}`);
    }

    // Layer C — write the channel state file BEFORE applying the rolling
    // window. The state file scans session.messages, so it needs to see the
    // full history including drawers/decisions that are about to be trimmed.
    try {
      await saveChannelState(session);
    } catch (err) {
      console.warn(`qwen-harness: saveChannelState failed: ${err}`);
    }

    // Layer C — drop pre-window turn pairs from session.messages. Their
    // semantic content lives on as drawers (Layer A pointers, future Layer B
    // facts) and surfaces via mpSearch in the system prompt.
    try {
      applyRollingWindow(session);
    } catch (err) {
      console.warn(`qwen-harness: applyRollingWindow failed: ${err}`);
    }

    await saveSession(session);
    return result;
  });
}

/** Exposed for the smoke endpoint so callers can inspect the saved session. */
export async function getQwenSession(
  channelId: string,
): Promise<QwenSession | null> {
  return loadSession(channelId);
}
