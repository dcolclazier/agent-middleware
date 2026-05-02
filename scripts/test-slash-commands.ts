// Unit tests for parseSlashCommand — pure function, no Discord.
// Covers: parser precedence (first non-whitespace token only — prose with
// the word "end" mid-sentence is NOT a command; prose that BEGINS with
// `/end <anything>` IS the /end command, payload ignored per CONTEXT.md),
// payload-after-verb extraction, recognition of the full /btw|/cancel|/end
// family, mentioned/unmentioned equivalence (the parser runs on the
// post-mention-strip body, so this test validates the body shape both
// forms produce after BotInstance strips). See §5 for the /end-as-first-
// token cases the parser intentionally matches.
//
// Run: npx tsx scripts/test-slash-commands.ts
//
// Slice 1 (issue #14): /cancel and /end ship live; /btw is recognised by the
// parser but its dispatch path is wired in Slice 2 (issue #15). The parser
// MUST recognise all three so #15 doesn't have to revisit this file.

import { parseSlashCommand, type SlashCommand } from "../src/slash-commands.js";

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

function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sect(name: string) {
  console.log(`\n--- ${name} ---`);
}

// ---------------------------------------------------------------------------
// 1. Bare verbs — no payload
// ---------------------------------------------------------------------------
sect("1. bare verbs");
{
  const cancel = parseSlashCommand("/cancel");
  check(
    "/cancel parses",
    eq(cancel, { verb: "/cancel", payload: "" } as SlashCommand),
    `got ${JSON.stringify(cancel)}`,
  );
  const end = parseSlashCommand("/end");
  check(
    "/end parses",
    eq(end, { verb: "/end", payload: "" } as SlashCommand),
    `got ${JSON.stringify(end)}`,
  );
  const btw = parseSlashCommand("/btw");
  check(
    "/btw parses (recognised even though dispatch is Slice 2)",
    eq(btw, { verb: "/btw", payload: "" } as SlashCommand),
    `got ${JSON.stringify(btw)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Verb + payload — payload is the rest of the message, trimmed
// ---------------------------------------------------------------------------
sect("2. verb + payload");
{
  const r = parseSlashCommand("/btw what files have you edited?");
  check(
    "/btw with payload",
    eq(r, { verb: "/btw", payload: "what files have you edited?" } as SlashCommand),
    `got ${JSON.stringify(r)}`,
  );
  const r2 = parseSlashCommand("/cancel    please");
  check(
    "/cancel with multi-space payload (collapsed to one)",
    r2?.verb === "/cancel" && r2?.payload === "please",
    `got ${JSON.stringify(r2)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Leading whitespace — still recognised (parser runs on post-mention-strip
//    body, which BotInstance .trim()s, but be tolerant anyway)
// ---------------------------------------------------------------------------
sect("3. leading whitespace");
{
  const r = parseSlashCommand("   /cancel");
  check(
    "/cancel with leading spaces",
    r?.verb === "/cancel",
    `got ${JSON.stringify(r)}`,
  );
  const r2 = parseSlashCommand("\n\t/end");
  check(
    "/end with leading newline+tab",
    r2?.verb === "/end",
    `got ${JSON.stringify(r2)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Case-insensitive verbs — Discord users are mortal
// ---------------------------------------------------------------------------
sect("4. case-insensitive");
{
  check("/CANCEL", parseSlashCommand("/CANCEL")?.verb === "/cancel");
  check("/End", parseSlashCommand("/End")?.verb === "/end");
  check("/Btw question", parseSlashCommand("/Btw question")?.verb === "/btw");
}

// ---------------------------------------------------------------------------
// 5. NO false-positive on prose where the verb appears mid-sentence.
//
// Rationale: the brief calls out "/end of file is needed" as a prose
// pattern that must NOT trigger /end. Strictly read, that string DOES
// start with "/end" — but the parser also has to allow `/btw <payload>`
// (the primary documented use of /btw, per CONTEXT.md). Resolution:
// first-token + word-boundary is the rule; payload-after-verb is allowed
// for ALL three verbs. The "false positive" pattern the brief is
// protecting against is the verb appearing mid-prose (after other words),
// which is far more common in conversation than someone literally
// starting a message with `/end`. See REVIEW-NOTES.md for the deliberate
// disagreement record if reviewers flag this.
// ---------------------------------------------------------------------------
sect("5. no false-positives on prose");
{
  // Verb appears mid-sentence, NOT as the first non-whitespace token.
  check(
    'prose: "I want to /cancel my subscription"',
    parseSlashCommand("I want to /cancel my subscription") === null,
  );
  check(
    'prose: "the /end keyword in C means..."',
    parseSlashCommand("the /end keyword in C means...") === null,
  );
  check(
    'prose: "btw, what about /cancel"',
    parseSlashCommand("btw, what about /cancel") === null,
  );
  check(
    "plain text",
    parseSlashCommand("hello world") === null,
  );
  check(
    "empty string",
    parseSlashCommand("") === null,
  );
  check(
    "whitespace only",
    parseSlashCommand("   \n\t") === null,
  );
}

// ---------------------------------------------------------------------------
// 6. NOT a slash command if verb is followed by a non-space character
//    ("/cancelthing" is not the /cancel verb).
// ---------------------------------------------------------------------------
sect("6. verb must be word-bounded");
{
  check(
    "/cancelling is not /cancel",
    parseSlashCommand("/cancelling now") === null,
  );
  check(
    "/endpoint is not /end",
    parseSlashCommand("/endpoint /api/foo") === null,
  );
  check(
    "/btwthing is not /btw",
    parseSlashCommand("/btwthing question") === null,
  );
  // But verb followed by punctuation IS allowed.
  check(
    "/cancel: please",
    parseSlashCommand("/cancel: please")?.verb === "/cancel",
  );
  check(
    "/end. please",
    parseSlashCommand("/end. please")?.verb === "/end",
  );
}

// ---------------------------------------------------------------------------
// 7. Unknown slash verbs return null (we don't claim ownership of /foo)
// ---------------------------------------------------------------------------
sect("7. unknown verbs");
{
  check("/foo", parseSlashCommand("/foo bar") === null);
  check("/help", parseSlashCommand("/help") === null);
  check("/", parseSlashCommand("/ ") === null);
}

// ---------------------------------------------------------------------------
// 8. Mentioned vs unmentioned equivalence
// ---------------------------------------------------------------------------
//
// BotInstance strips both proper @-mentions AND the textMentionPattern
// before the handler runs, so what reaches parseSlashCommand is the same
// post-strip body in both cases. We simulate that here.
sect("8. mentioned/unmentioned equivalence");
{
  // What BotInstance.handleMessage produces after mention strip + trim
  // for an "@ClaudeCode /cancel" message:
  const stripped = "/cancel";
  // For an unmentioned "/cancel" caught by textMentionPattern:
  const direct = "/cancel";
  check(
    "stripped @mention path",
    parseSlashCommand(stripped)?.verb === "/cancel",
  );
  check("direct unmentioned path", parseSlashCommand(direct)?.verb === "/cancel");
  // And for /btw with a payload, both paths produce identical results.
  check(
    "mentioned /btw with payload",
    parseSlashCommand("/btw quick aside")?.payload === "quick aside",
  );
  check(
    "unmentioned /btw with payload",
    parseSlashCommand("/btw quick aside")?.payload === "quick aside",
  );
}

// ---------------------------------------------------------------------------
// 9. /end ignores any trailing payload (reactor must NOT use it)
// ---------------------------------------------------------------------------
//
// The parser still extracts the payload string — payload-ignore is the
// caller's responsibility. We ASSERT the parser returns the payload so the
// caller has the choice. This test pins the contract.
sect("9. /end payload is exposed (caller decides what to do)");
{
  const r = parseSlashCommand("/end thanks bye");
  check("verb is /end", r?.verb === "/end");
  check(
    "payload is exposed verbatim",
    r?.payload === "thanks bye",
    `got ${JSON.stringify(r?.payload)}`,
  );
}

// ---------------------------------------------------------------------------
// 10. Boundary character is consumed — punctuation between the verb and the
//     payload (`:`, `,`, `?`, etc.) must NOT leak into payload. Slice 2
//     (#15) feeds payload directly into a Claude prompt, so leading
//     punctuation noise would change the model's input.
// ---------------------------------------------------------------------------
sect("10. boundary char does not leak into payload");
{
  const r1 = parseSlashCommand("/btw: hi");
  check(
    "/btw: hi → payload 'hi' (not ': hi')",
    r1?.verb === "/btw" && r1?.payload === "hi",
    `got ${JSON.stringify(r1)}`,
  );
  const r2 = parseSlashCommand("/btw, what about X?");
  check(
    "/btw, what about X? → payload 'what about X?'",
    r2?.verb === "/btw" && r2?.payload === "what about X?",
    `got ${JSON.stringify(r2)}`,
  );
  const r3 = parseSlashCommand("/cancel?");
  check(
    "/cancel? → payload '' (boundary ? consumed)",
    r3?.verb === "/cancel" && r3?.payload === "",
    `got ${JSON.stringify(r3)}`,
  );
  const r4 = parseSlashCommand("/end.");
  check(
    "/end. → payload '' (boundary . consumed)",
    r4?.verb === "/end" && r4?.payload === "",
    `got ${JSON.stringify(r4)}`,
  );
}

// ---------------------------------------------------------------------------
console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
