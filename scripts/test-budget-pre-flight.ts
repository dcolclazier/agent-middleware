// Pre-flight wire-budget validation tests (Slice #3).
// Run: npx tsx scripts/test-budget-pre-flight.ts
//
// Exercises the three-constant + seven-sub-budget system introduced by
// ADR-0003 and the new validateWireBudget() pre-flight check.
//
// What this validates:
//   1. WIRE_HARD_CAP / SYSTEM_BUDGET / TURN_BUDGET constants exported and
//      shaped correctly (30k / 8k / 22k; SYSTEM + TURN = HARD_CAP).
//   2. The seven sub-budget constants exist and sum to SYSTEM_BUDGET (8k).
//   3. validateWireBudget returns the documented shape with three breakdown
//      buckets (systemPrompt, messages, overlay).
//   4. validateWireBudget rejects an over-cap payload (ok=false), accepts
//      an under-cap payload (ok=true).
//   5. compressOldMessages now targets TURN_BUDGET (not the old 25k soft
//      limit) — a session whose messages exceed TURN_BUDGET by >2x is
//      compressed below TURN_BUDGET (no preserve-last-turn override).
//   6. End-to-end: a fixture session with a tool returning ~50KB body,
//      run through compressOldMessages + validateWireBudget, ends up ≤
//      WIRE_HARD_CAP and the original oversized overlay entry was evicted.

import {
  compressOldMessages,
  validateWireBudget,
  WIRE_HARD_CAP,
  SYSTEM_BUDGET,
  TURN_BUDGET,
  PERSONA_BUDGET,
  TOOLS_INSTRUCTIONS_BUDGET,
  CHANNEL_STATE_BUDGET,
  VERBATIM_WINDOW_BUDGET,
  TOPICAL_DECISIONS_BUDGET,
  TOPICAL_PROSE_BUDGET,
  SYSTEM_BUDGET_MARGIN,
} from "../src/qwen-harness.js";
import type { QwenSession } from "../src/qwen-harness.js";
import { estimateTokens } from "../src/token-estimate.js";

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

// Diverse filler — same pool as test-overlay-budget.ts so token counts are
// comparable. `"x".repeat(N)` encodes to very few tokens; we need real prose.
const LOREM_POOL = [
  "The resistance cell gathered at midnight. Kaelen surveyed the room.",
  "Consensus nodes flickered amber in the gloom. Two were corrupted.",
  "Marcus pulled the cipher deck and shuffled. Twenty-seven cards per hand.",
  "The handover protocol was failing in the shift districts. Loud failing.",
  "Old industrial machinery wheezed in the corner of the factory floor.",
  "Data fragments from the Archive Protocol bled across the network edges.",
  "She ran diagnostics on the quantum relay and swore under her breath.",
  "The goblin queen had grown restless. Her spies reported three incursions.",
];
function loremBytes(approxBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size < approxBytes) {
    const line = LOREM_POOL[i % LOREM_POOL.length]!;
    parts.push(`${line} [frag ${i}]`);
    size += line.length + 12;
    i++;
  }
  return parts.join(" ");
}

function mkSession(userTurns: number, stubBytes: number = 200): QwenSession {
  const messages: any[] = [];
  for (let i = 0; i < userTurns; i++) {
    messages.push({ role: "user", content: `user msg ${i} context` });
    const callId = `call_${i}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: callId, type: "function", function: { name: "canon_read", arguments: "{}" } },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: `[canon_read stub ${i}] ${loremBytes(Math.max(100, stubBytes - 50))}`,
    });
  }
  return {
    id: "test-session",
    channelId: "test-channel",
    messages,
    taskState: "running",
    currentTurn: 0,
    toolFailures: {},
    hadCommitDuringThisTask: false,
    lastUserMessageRequestedCanon: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// 1. Top-level constants exist with correct values
sect("1. WIRE_HARD_CAP / SYSTEM_BUDGET / TURN_BUDGET shape");
{
  check("WIRE_HARD_CAP === 30_000", WIRE_HARD_CAP === 30_000, `got ${WIRE_HARD_CAP}`);
  check("SYSTEM_BUDGET === 8_000", SYSTEM_BUDGET === 8_000, `got ${SYSTEM_BUDGET}`);
  check("TURN_BUDGET === 22_000", TURN_BUDGET === 22_000, `got ${TURN_BUDGET}`);
  check(
    "SYSTEM_BUDGET + TURN_BUDGET === WIRE_HARD_CAP",
    SYSTEM_BUDGET + TURN_BUDGET === WIRE_HARD_CAP,
  );
}

// 2. Sub-budget constants sum to SYSTEM_BUDGET
sect("2. seven sub-budget constants sum to SYSTEM_BUDGET");
{
  check("PERSONA_BUDGET === 1500", PERSONA_BUDGET === 1500, `got ${PERSONA_BUDGET}`);
  check(
    "TOOLS_INSTRUCTIONS_BUDGET === 1000",
    TOOLS_INSTRUCTIONS_BUDGET === 1000,
    `got ${TOOLS_INSTRUCTIONS_BUDGET}`,
  );
  check(
    "CHANNEL_STATE_BUDGET === 500",
    CHANNEL_STATE_BUDGET === 500,
    `got ${CHANNEL_STATE_BUDGET}`,
  );
  check(
    "VERBATIM_WINDOW_BUDGET === 2500",
    VERBATIM_WINDOW_BUDGET === 2500,
    `got ${VERBATIM_WINDOW_BUDGET}`,
  );
  check(
    "TOPICAL_DECISIONS_BUDGET === 1500",
    TOPICAL_DECISIONS_BUDGET === 1500,
    `got ${TOPICAL_DECISIONS_BUDGET}`,
  );
  check(
    "TOPICAL_PROSE_BUDGET === 500",
    TOPICAL_PROSE_BUDGET === 500,
    `got ${TOPICAL_PROSE_BUDGET}`,
  );
  check(
    "SYSTEM_BUDGET_MARGIN === 500",
    SYSTEM_BUDGET_MARGIN === 500,
    `got ${SYSTEM_BUDGET_MARGIN}`,
  );
  const sum =
    PERSONA_BUDGET +
    TOOLS_INSTRUCTIONS_BUDGET +
    CHANNEL_STATE_BUDGET +
    VERBATIM_WINDOW_BUDGET +
    TOPICAL_DECISIONS_BUDGET +
    TOPICAL_PROSE_BUDGET +
    SYSTEM_BUDGET_MARGIN;
  check(
    "sum of sub-budgets === SYSTEM_BUDGET",
    sum === SYSTEM_BUDGET,
    `sum=${sum}, expected ${SYSTEM_BUDGET}`,
  );
}

// 3. validateWireBudget shape & happy path
sect("3. validateWireBudget shape — under-cap payload accepted");
{
  const sysPrompt = "You are a helpful agent.";
  const outgoing = [
    { role: "system", content: sysPrompt },
    { role: "user", content: "Hello." },
  ];
  const result = validateWireBudget(sysPrompt, outgoing, new Map());
  check("returns ok=true for tiny payload", result.ok === true);
  check("estimatedTokens > 0", result.estimatedTokens > 0, `got ${result.estimatedTokens}`);
  check("estimatedTokens < WIRE_HARD_CAP", result.estimatedTokens < WIRE_HARD_CAP);
  check("breakdown has systemPrompt", typeof result.breakdown.systemPrompt === "number");
  check("breakdown has messages", typeof result.breakdown.messages === "number");
  check("breakdown has overlay", typeof result.breakdown.overlay === "number");
  check(
    "breakdown.overlay === 0 (no overlay)",
    result.breakdown.overlay === 0,
    `got ${result.breakdown.overlay}`,
  );
}

// 4. validateWireBudget rejects over-cap payload
sect("4. validateWireBudget rejects over-cap payload");
{
  const sysPrompt = "You are a helpful agent.";
  // 40k tokens worth of prose — well over WIRE_HARD_CAP=30k.
  const huge = loremBytes(160_000);
  const outgoing = [
    { role: "system", content: sysPrompt },
    { role: "user", content: huge },
  ];
  const result = validateWireBudget(sysPrompt, outgoing, new Map());
  check("returns ok=false for huge payload", result.ok === false);
  check(
    "estimatedTokens > WIRE_HARD_CAP",
    result.estimatedTokens > WIRE_HARD_CAP,
    `got ${result.estimatedTokens}`,
  );
  check("breakdown.messages > breakdown.systemPrompt", result.breakdown.messages > result.breakdown.systemPrompt);
}

// 5. validateWireBudget counts overlay-hydrated bytes
sect("5. validateWireBudget counts overlay-hydrated bytes");
{
  const sysPrompt = "You are a helpful agent.";
  const overlay = new Map<string, string>();
  overlay.set("call_X", loremBytes(160_000)); // ~40k tokens of overlay
  const outgoing = [
    { role: "system", content: sysPrompt },
    {
      role: "tool",
      tool_call_id: "call_X",
      content: "[stub: small]",
    },
  ];
  const result = validateWireBudget(sysPrompt, outgoing, overlay);
  check(
    "breakdown.overlay > 0 when overlay has live entry",
    result.breakdown.overlay > 0,
    `got ${result.breakdown.overlay}`,
  );
  // Wire estimate should be over the cap because of overlay
  check(
    "ok=false when overlay alone pushes over cap",
    result.ok === false,
    `est=${result.estimatedTokens}`,
  );
}

// 6. compressOldMessages now targets TURN_BUDGET
sect("6. compressOldMessages compresses to TURN_BUDGET (not 25k)");
{
  // Build 5 turn groups, each ~6k bytes ≈ ~1.5k tokens of stub prose. With
  // 5 turns we're at ~7.5k tokens of stubs — under TURN_BUDGET. Add overlay
  // pressure that pushes the wire estimate well over TURN_BUDGET.
  const s = mkSession(5, 200);
  const overlay = new Map<string, string>();
  for (let i = 0; i < 5; i++) {
    overlay.set(`call_${i}`, loremBytes(50_000));
  }
  await compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  // After compression the wire estimate should be ≤ TURN_BUDGET.
  let postText = "[SYSTEM]\nshort";
  for (const m of s.messages) postText += JSON.stringify(m);
  const liveIds = new Set(
    s.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => m.tool_call_id),
  );
  for (const [id, content] of overlay.entries()) {
    if (liveIds.has(id)) postText += content;
  }
  const finalTokens = estimateTokens(postText);
  check(
    "post-compression wire ≤ TURN_BUDGET",
    finalTokens <= TURN_BUDGET,
    `final=${finalTokens}, budget=${TURN_BUDGET}`,
  );
}

// 7. End-to-end: 50KB tool body fixture
sect("7. fixture — 50KB tool result body lands under WIRE_HARD_CAP");
{
  const s = mkSession(3, 200);
  const overlay = new Map<string, string>();
  // The "current turn" group has its tool_call still in the latest tool stub
  // (call_2). Stage a 50KB body for it AND a couple older big bodies, so the
  // compressor must evict at least the older ones.
  overlay.set("call_0", loremBytes(50_000));
  overlay.set("call_1", loremBytes(50_000));
  overlay.set("call_2", loremBytes(50_000));
  // Build a "system prompt" of realistic ~6k token size (close to but under
  // SYSTEM_BUDGET) so the test exercises the full wire estimate.
  const systemPrompt = `[IDENTITY]\n${loremBytes(8_000)}\n\n[INSTRUCTIONS]\n${loremBytes(2_000)}`;
  await compressOldMessages(s, systemPrompt, overlay);
  // Now run validateWireBudget on the post-compression outgoing.
  const outgoing: any[] = [
    { role: "system", content: systemPrompt },
    ...s.messages.map((m: any) => {
      if (m?.role === "tool" && m.tool_call_id && overlay.has(m.tool_call_id)) {
        return { ...m, content: overlay.get(m.tool_call_id) };
      }
      return m;
    }),
  ];
  const result = validateWireBudget(systemPrompt, outgoing, overlay);
  check(
    "post-compression wire ≤ WIRE_HARD_CAP",
    result.estimatedTokens <= WIRE_HARD_CAP,
    `final=${result.estimatedTokens}, cap=${WIRE_HARD_CAP}`,
  );
  check(
    "validateWireBudget ok=true post-compression",
    result.ok === true,
    `est=${result.estimatedTokens}`,
  );
  // At least one of the older overlay entries must have been evicted —
  // they can't all coexist under the budget.
  const remaining = Array.from(overlay.keys());
  check(
    "compression evicted at least one overlay entry",
    remaining.length < 3,
    `remaining: ${remaining.join(",")}`,
  );
}

console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
