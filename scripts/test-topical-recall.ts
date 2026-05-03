// Smoke tests for topical recall — last-3-user-messages query and the
// dual-wing search rendering ([RELEVANT DECISIONS] + [RELEVANT PROSE]) in
// the Qwen system prompt (Slice 7).
//
// Run: npx tsx scripts/test-topical-recall.ts

import {
  backfillHumanUserMessagesIfNeeded,
  buildSystemPrompt,
  buildLastUserMessagesQuery,
  TOPICAL_DECISIONS_BUDGET,
  TOPICAL_PROSE_BUDGET,
  type QwenSession,
} from "../src/qwen-harness.js";
import { estimateTokens } from "../src/token-estimate.js";
import type { TranscriptEntry } from "../src/channel-transcript.js";

let failed = 0;
let passed = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function sect(name: string) {
  console.log(`\n--- ${name} ---`);
}

const fakePersona = {
  identity: "test-identity",
  soul: "test-soul",
  memory: "test-memory",
};

const noTools: never[] = [];

function makeSession(userMessages: string[]): QwenSession {
  // Interleave assistant messages between user messages to mimic a real turn
  // history. The helper now reads `humanUserMessages` (synthetic-pushback
  // resilient); we mirror that field here to match what runQwenTurn does in
  // production. Tests in `1b` exercise the legacy `messages`-only fallback
  // for sessions persisted before `humanUserMessages` existed.
  const messages: any[] = [];
  for (let i = 0; i < userMessages.length; i++) {
    messages.push({ role: "user", content: userMessages[i] });
    messages.push({ role: "assistant", content: `assistant-reply-${i}` });
  }
  return {
    id: "test-session",
    channelId: "test-channel",
    messages,
    taskState: "idle",
    currentTurn: 0,
    toolFailures: {},
    hadCommitDuringThisTask: false,
    lastUserMessageRequestedCanon: false,
    humanUserMessages: [...userMessages],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  // 1. buildLastUserMessagesQuery — concatenates last 3 by newline.
  sect("1. buildLastUserMessagesQuery — last 3 user messages, newline-joined");
  {
    const session = makeSession([
      "first user message",
      "second user message",
      "third user message",
      "fourth user message",
      "fifth user message",
    ]);
    const q = buildLastUserMessagesQuery(session, 3);
    check(
      "query equals concatenation of last 3 user messages joined by newline",
      q === "third user message\nfourth user message\nfifth user message",
      `got: ${JSON.stringify(q)}`,
    );
  }

  // 1a. Synthetic harness pushbacks (also pushed as role:"user" — e.g. the
  // text-only-gate canon-commit nudge in runQwenTurn) must NOT leak into
  // the topical-recall query. Only entries in `humanUserMessages` count.
  sect(
    "1a. synthetic role:'user' pushbacks in messages don't leak into query",
  );
  {
    const session = makeSession(["real human turn one", "real human turn two"]);
    // Inject a synthetic harness pushback into `messages` (mirrors what
    // runQwenTurn does at the text-only gate) — this entry is role:"user"
    // but isn't a human-typed message, so the query must skip it.
    session.messages.push({
      role: "user",
      content:
        "You produced a text-only response but the task asked for canon work and you did not call canon_commit. Commit your work now or call task_complete with an explanation.",
    });
    const q = buildLastUserMessagesQuery(session, 3);
    check(
      "synthetic pushback content is absent from query",
      !q.includes("Commit your work now"),
      `got: ${JSON.stringify(q)}`,
    );
    check(
      "real human messages remain in query",
      q.includes("real human turn one") && q.includes("real human turn two"),
      `got: ${JSON.stringify(q)}`,
    );
  }

  // 1b. Legacy session JSON without `humanUserMessages` falls back to
  // scanning `messages` (defensive path for callers that bypass
  // runQwenTurn's backfill, e.g. read-only HTTP introspection). The
  // fallback also skips the synthetic harness pushback so it can't leak
  // through the legacy code path.
  sect("1b. legacy session (no humanUserMessages) falls back to messages scan");
  {
    const legacy: QwenSession = {
      id: "legacy",
      channelId: "x",
      messages: [
        { role: "user", content: "legacy msg one" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "legacy msg two" },
        // Synthetic harness pushback in the legacy stream — must NOT leak
        // through the legacy fallback either.
        {
          role: "user",
          content:
            "You produced a text-only response but the task asked for canon work and you did not call canon_commit. Commit your work now or call task_complete with an explanation.",
        },
      ],
      taskState: "idle",
      currentTurn: 0,
      toolFailures: {},
      hadCommitDuringThisTask: false,
      lastUserMessageRequestedCanon: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const q = buildLastUserMessagesQuery(legacy, 3);
    check(
      "legacy fallback joins real user entries in arrival order",
      q === "legacy msg one\nlegacy msg two",
      `got: ${JSON.stringify(q)}`,
    );
    check(
      "synthetic pushback is excluded from the legacy fallback path",
      !q.includes("Commit your work now"),
    );
  }

  // 1c. backfillHumanUserMessagesIfNeeded — preserves issue #7's pivot
  // context for legacy sessions on first post-upgrade turn. Without this,
  // a legacy session that loaded with `humanUserMessages: undefined` and
  // had the field eagerly initialised at the runQwenTurn push site would
  // see only the current message in the topical query — losing the
  // prior-context buffer for short follow-ups ("ok"/"yes").
  sect("1c. backfillHumanUserMessagesIfNeeded — legacy → migrated");
  {
    const legacy: QwenSession = {
      id: "legacy-needing-backfill",
      channelId: "x",
      messages: [
        { role: "user", content: "Let's plan goblin season three." },
        { role: "assistant", content: "Sounds good." },
        { role: "user", content: "Lean into the swarm angle." },
        { role: "assistant", content: "Got it." },
        // Synthetic harness pushback — must be skipped during backfill.
        {
          role: "user",
          content:
            "You produced a text-only response but the task asked for canon work and you did not call canon_commit. Commit your work now or call task_complete with an explanation.",
        },
        { role: "assistant", content: "Apologies, committing." },
      ],
      taskState: "idle",
      currentTurn: 0,
      toolFailures: {},
      hadCommitDuringThisTask: false,
      lastUserMessageRequestedCanon: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    backfillHumanUserMessagesIfNeeded(legacy);
    check(
      "backfill populates humanUserMessages with all real user entries",
      legacy.humanUserMessages?.length === 2,
      `got ${legacy.humanUserMessages?.length}`,
    );
    check(
      "backfill skips the synthetic harness pushback",
      !legacy.humanUserMessages?.some((m) =>
        m.startsWith("You produced a text-only response"),
      ),
    );
    // Idempotent — calling again should not re-scan.
    legacy.humanUserMessages!.push("manually-added");
    backfillHumanUserMessagesIfNeeded(legacy);
    check(
      "backfill is idempotent (no-op when field is already present)",
      legacy.humanUserMessages?.length === 3,
      `got ${legacy.humanUserMessages?.length}`,
    );
    // After backfill, query reflects the migration — pivot like "ok"
    // following the backfilled context preserves issue #7's behavior.
    const sessionWithPivot: QwenSession = {
      ...legacy,
      humanUserMessages: undefined as unknown as string[] | undefined,
    };
    sessionWithPivot.humanUserMessages = undefined;
    backfillHumanUserMessagesIfNeeded(sessionWithPivot);
    sessionWithPivot.humanUserMessages!.push("ok");
    const q = buildLastUserMessagesQuery(sessionWithPivot, 3);
    check(
      "post-backfill query buffers 'ok' against the prior 2 real turns",
      q.includes("goblin season three") &&
        q.includes("swarm angle") &&
        q.endsWith("ok"),
      `got: ${JSON.stringify(q)}`,
    );
  }

  // 2. Fewer-than-n user messages — return whatever exists, joined.
  sect("2. fewer-than-n — joins what exists");
  {
    const sessionTwo = makeSession(["hello", "world"]);
    const qTwo = buildLastUserMessagesQuery(sessionTwo, 3);
    check(
      "with 2 user messages and n=3, returns 'hello\\nworld'",
      qTwo === "hello\nworld",
      `got: ${JSON.stringify(qTwo)}`,
    );

    const sessionOne = makeSession(["only"]);
    const qOne = buildLastUserMessagesQuery(sessionOne, 3);
    check(
      "with 1 user message and n=3, returns 'only'",
      qOne === "only",
      `got: ${JSON.stringify(qOne)}`,
    );

    const sessionEmpty: QwenSession = {
      id: "x",
      channelId: "x",
      messages: [],
      taskState: "idle",
      currentTurn: 0,
      toolFailures: {},
      hadCommitDuringThisTask: false,
      lastUserMessageRequestedCanon: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const qEmpty = buildLastUserMessagesQuery(sessionEmpty, 3);
    check(
      "with no user messages, returns empty string",
      qEmpty === "",
      `got: ${JSON.stringify(qEmpty)}`,
    );
  }

  // 3. Conversational-pivot pattern — last 3 still includes prior context.
  sect("3. conversational pivot — 'ok' alone is buffered by prior 2 messages");
  {
    const session = makeSession([
      "Let's plan goblin season three's bestiary entry.",
      "I'm thinking we lean into the swarm angle for goblins.",
      "ok",
    ]);
    const q = buildLastUserMessagesQuery(session, 3);
    check(
      "pivot 'ok' is concatenated with the two prior messages",
      q.includes("goblin season three") &&
        q.includes("swarm angle") &&
        q.endsWith("\nok"),
      `got: ${JSON.stringify(q)}`,
    );
    // Single-message naive query would just be "ok" — confirm we are NOT
    // doing that.
    check(
      "query is NOT just the last message in isolation",
      q !== "ok",
    );
  }

  // 4. buildSystemPrompt renders [RELEVANT DECISIONS] block when given
  //    decisions, omits old [RELEVANT MEMORIES] block.
  sect("4. buildSystemPrompt renders [RELEVANT DECISIONS], omits old [RELEVANT MEMORIES]");
  {
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      decisions: ["decision-A: ship slice 7", "naming-B: call it topical-recall"],
      prose: [],
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    check(
      "[RELEVANT DECISIONS] header present",
      prompt.includes("[RELEVANT DECISIONS]"),
    );
    check(
      "decision-A line rendered",
      prompt.includes("decision-A: ship slice 7"),
    );
    check(
      "naming-B line rendered",
      prompt.includes("naming-B: call it topical-recall"),
    );
    // The old [RELEVANT MEMORIES] block must NOT appear as a section header.
    check(
      "no [RELEVANT MEMORIES] block-header in rendered prompt",
      !/(^|\n\n)\[RELEVANT MEMORIES\]\n/.test(prompt),
    );
  }

  // 5. [RELEVANT PROSE] block — entries rendered, header present.
  sect("5. [RELEVANT PROSE] block renders prose entries");
  {
    const proseEntry: TranscriptEntry = {
      channelId: "test-channel",
      author: "Alice",
      text: "earlier we agreed goblins use mob tactics",
      timestamp: "2026-04-15T12:00:00Z",
    };
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      decisions: [],
      prose: [proseEntry],
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    check(
      "[RELEVANT PROSE] header present",
      prompt.includes("[RELEVANT PROSE]"),
    );
    check(
      "prose body text rendered",
      prompt.includes("earlier we agreed goblins use mob tactics"),
    );
    check(
      "prose author rendered",
      prompt.includes("Alice"),
    );
  }

  // 6. Empty inputs → both blocks omitted entirely (no empty headers).
  sect("6. empty decisions/prose → blocks omitted");
  {
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      decisions: [],
      prose: [],
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    check(
      "no [RELEVANT DECISIONS] block-header when decisions empty",
      !/(^|\n\n)\[RELEVANT DECISIONS\]\n/.test(prompt),
    );
    check(
      "no [RELEVANT PROSE] block-header when prose empty",
      !/(^|\n\n)\[RELEVANT PROSE\]\n/.test(prompt),
    );
  }

  // 7. Each block trimmed to its sub-budget.
  sect("7. blocks trim to TOPICAL_DECISIONS_BUDGET / TOPICAL_PROSE_BUDGET");
  {
    // Each decision ~700 chars ≈ 200 tokens. 10 of them ≈ 2000 tokens — over
    // the 1500-token budget, so trimming must drop at least the last few.
    const med = "x ".repeat(350);
    const decisions: string[] = [];
    for (let i = 0; i < 10; i++) decisions.push(`d${i}: ${med}`);

    const prompt = buildSystemPrompt({
      persona: fakePersona,
      decisions,
      prose: [],
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    const headerIdx = prompt.indexOf("[RELEVANT DECISIONS]");
    check(
      "[RELEVANT DECISIONS] block rendered (not entirely dropped)",
      headerIdx >= 0,
    );
    const after = prompt.slice(headerIdx);
    const blank = after.indexOf("\n\n");
    const block = blank >= 0 ? after.slice(0, blank) : after;
    const blockTokens = estimateTokens(block);
    check(
      `decisions block tokens (${blockTokens}) ≤ TOPICAL_DECISIONS_BUDGET (${TOPICAL_DECISIONS_BUDGET})`,
      blockTokens <= TOPICAL_DECISIONS_BUDGET,
    );
    // Confirm trimming actually occurred — the last entry must be dropped.
    check(
      "last (over-budget) decision is trimmed away",
      !block.includes("d9:"),
    );
    // First entry survives (drop-from-end policy).
    check(
      "first decision is retained",
      block.includes("d0:"),
    );
  }
  {
    // Prose: ~250-char entries ≈ 70 tokens each. 10 of them ≈ 700 tokens —
    // over the 500-token budget so some must be dropped.
    const small = "y ".repeat(120);
    const prose: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      prose.push({
        channelId: "ch",
        author: `Author${i}`,
        text: `${small} #${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      decisions: [],
      prose,
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    const headerIdx = prompt.indexOf("[RELEVANT PROSE]");
    check(
      "[RELEVANT PROSE] block rendered (not entirely dropped)",
      headerIdx >= 0,
    );
    const after = prompt.slice(headerIdx);
    const blank = after.indexOf("\n\n");
    const block = blank >= 0 ? after.slice(0, blank) : after;
    const blockTokens = estimateTokens(block);
    check(
      `prose block tokens (${blockTokens}) ≤ TOPICAL_PROSE_BUDGET (${TOPICAL_PROSE_BUDGET})`,
      blockTokens <= TOPICAL_PROSE_BUDGET,
    );
    check(
      "first prose entry (Author0) is retained",
      block.includes("Author0:"),
    );
    check(
      "last prose entry (Author9) is trimmed away",
      !block.includes("Author9:"),
    );
  }

  // 8a. Five-user-message scenario — query is the last 3, NOT the last 1.
  sect("8a. five user messages → search query is concat of last 3 (not last 1)");
  {
    const session = makeSession([
      "decisions about the goblin bestiary entry",
      "let's say goblins are mob-tactics specialists",
      "and they prefer night ambushes over day raids",
      "ok",
      "yes",
    ]);
    const q = buildLastUserMessagesQuery(session, 3);
    // Query must include the topical context that drove "ok"/"yes".
    check(
      "query contains topical context (night ambushes)",
      q.includes("night ambushes"),
    );
    check(
      "query ends with the conversational pivots in order",
      q.endsWith("ok\nyes"),
    );
    // The single-message naive query would fail topical recall (just "yes")
    // — confirm the helper returns a multi-line concat instead.
    const lines = q.split("\n");
    check(
      "query has exactly 3 lines (last 3 user messages)",
      lines.length === 3,
      `got ${lines.length}`,
    );
  }

  // 8. Both blocks render side-by-side correctly.
  sect("8. dual-wing — both [RELEVANT DECISIONS] and [RELEVANT PROSE] render together");
  {
    const proseEntry: TranscriptEntry = {
      channelId: "test-channel",
      author: "Bob",
      text: "bob's earlier note about cats",
      timestamp: "2026-04-20T09:00:00Z",
    };
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      decisions: ["dec-1: cats are felines"],
      prose: [proseEntry],
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    check(
      "[RELEVANT DECISIONS] header present",
      prompt.includes("[RELEVANT DECISIONS]"),
    );
    check(
      "[RELEVANT PROSE] header present",
      prompt.includes("[RELEVANT PROSE]"),
    );
    check(
      "decision content rendered",
      prompt.includes("dec-1: cats are felines"),
    );
    check(
      "prose content rendered",
      prompt.includes("bob's earlier note about cats"),
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("test-topical-recall failed:", err);
  process.exit(1);
});
