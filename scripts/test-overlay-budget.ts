// Unit tests for compressOldMessages overlay-budget accounting (Pass 7c).
// Run: npx tsx scripts/test-overlay-budget.ts
//
// The bug this fixes: compressOldMessages estimated bytes from session.messages
// (stubs) while the overlay-hydrated `outgoing` is what actually hits vLLM.
// The real wire cost was hidden from the budget check. These tests verify:
//   1. Compression now counts overlay bytes in its estimate.
//   2. Oldest overlay entries get evicted first (cheapest semantic loss).
//   3. Orphaned overlay entries (whose tool_call_id is no longer in
//      session.messages) get pruned unconditionally.
//   4. Turn-group eviction still works as a second-stage fallback when
//      overlay eviction alone isn't enough.
//   5. The last turn group is always preserved even under severe pressure.

import { compressOldMessages } from "../src/qwen-harness.js";
import type { QwenSession } from "../src/qwen-harness.js";

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

// Diverse filler so tiktoken can't compress it to one token — we use
// pseudo-prose generated from a short lorem pool. This matters because
// `"x".repeat(N)` encodes to very few tokens in cl100k_base, making
// byte-size → token-count math misleading in tests.
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

// Build a fake session with N user messages, each followed by one assistant
// with one tool_call and one tool result stub. The tool_call_ids are
// deterministic so tests can reference them.
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

// 1. No overlay, no compression needed
sect("1. small session, no overlay, no-op");
{
  const s = mkSession(2);
  const overlay = new Map<string, string>();
  const originalLen = s.messages.length;
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  check("messages untouched", s.messages.length === originalLen);
  check("overlay untouched", overlay.size === 0);
}

// 2. Overlay within budget — no eviction
sect("2. overlay within budget, no eviction");
{
  const s = mkSession(2);
  const overlay = new Map<string, string>();
  overlay.set("call_0", "x".repeat(1000));
  const originalLen = s.messages.length;
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  check("messages untouched", s.messages.length === originalLen);
  check("overlay size unchanged", overlay.size === 1);
  check("overlay entry preserved", overlay.get("call_0") !== undefined);
}

// 3. Overlay oversized — oldest evicted first
sect("3. oversized overlay — oldest evicted first");
{
  const s = mkSession(3);
  const overlay = new Map<string, string>();
  // Three big overlay entries with diverse content so tiktoken actually
  // counts them as many tokens, not compressed runs. ~40KB each.
  overlay.set("call_0", loremBytes(40_000));
  overlay.set("call_1", loremBytes(40_000));
  overlay.set("call_2", loremBytes(40_000));
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  check("at least one overlay entry evicted", overlay.size < 3, `remaining keys: ${Array.from(overlay.keys()).join(",")}`);
  // Whatever remains should be the NEWEST entries (evict oldest first)
  if (overlay.size === 1) {
    check("only call_2 remains (newest)", overlay.has("call_2"));
  } else if (overlay.size === 2) {
    check("call_1 and call_2 remain (call_0 evicted)", overlay.has("call_1") && overlay.has("call_2") && !overlay.has("call_0"));
  }
  // All stubs should still be present — overlay eviction doesn't remove session.messages
  check("session.messages intact after overlay eviction", s.messages.length === 9);
}

// 4. Orphan pruning
sect("4. orphan overlay entries pruned unconditionally");
{
  const s = mkSession(2);
  const overlay = new Map<string, string>();
  overlay.set("call_0", "x".repeat(100));
  overlay.set("call_ORPHAN", "y".repeat(100));
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  check("live entry preserved", overlay.has("call_0"));
  check("orphan pruned", !overlay.has("call_ORPHAN"));
}

// 5. Overlay eviction insufficient — drop turn groups
sect("5. still over budget after overlay gone — drop turn groups");
{
  // Each stub ~60KB of lorem (real prose, not compressible runs) so 5 turns
  // easily exceeds 25k tokens with headroom for the test to be deterministic.
  const s = mkSession(5, 60_000);
  const overlay = new Map<string, string>();
  const originalLen = s.messages.length;
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  check("turn groups dropped", s.messages.length < originalLen, `len was ${s.messages.length}, orig ${originalLen}`);
  // Last user message must always survive
  const hasLastUser = s.messages.some((m: any) => m.role === "user");
  check("at least one user message present", hasLastUser);
}

// 6. Combined: overlay eviction + turn-group drop
sect("6. combined — overlay + turn groups");
{
  const s = mkSession(5);
  const overlay = new Map<string, string>();
  for (let i = 0; i < 4; i++) {
    overlay.set(`call_${i}`, loremBytes(30_000));
  }
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  // No orphan overlay entries after compression
  const liveIds = new Set(
    s.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => m.tool_call_id),
  );
  let orphanCount = 0;
  for (const k of overlay.keys()) {
    if (!liveIds.has(k)) orphanCount++;
  }
  check("no orphan overlay entries after compression", orphanCount === 0);
  const users = s.messages.filter((m: any) => m.role === "user");
  check("at least the last user message survives", users.length >= 1);
}

// 7. Single user message with giant overlay
sect("7. single user message with giant overlay");
{
  const s = mkSession(1);
  const overlay = new Map<string, string>();
  overlay.set("call_0", loremBytes(200_000)); // 200KB overlay
  compressOldMessages(s, "[SYSTEM]\nshort", overlay);
  // Overlay eviction is the only stage that can help — cannot drop last turn group
  check("overlay entry evicted", !overlay.has("call_0"));
  check("session.messages untouched (cannot drop last turn)", s.messages.length === 3);
}

console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
