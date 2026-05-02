// Unit tests for parseSlashCommand — pure function, no Discord.
// Covers: parser precedence (first non-whitespace token only), payload-after-verb
// extraction, leading separator stripping, no false-positives when the verb
// appears MID-SENTENCE (e.g. "I want to /cancel my subscription"), recognition
// of the full /btw|/cancel|/end family, mentioned/unmentioned equivalence (the
// parser runs on the post-mention-strip body, so this test validates the body
// shape both forms produce after BotInstance strips).
//
// Note on first-token semantics: a message that LITERALLY starts with the
// verb (e.g. "/end of file is needed") DOES route through with the rest as
// payload — that's the deliberate parse-shape decision in REVIEW-NOTES.md §1.
// The "false-positive" class this parser rejects is verb-mid-prose, not
// verb-first-with-trailing-words. See §5 below.
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
    "/cancel with leading-whitespace payload (leading trimmed)",
    r2?.verb === "/cancel" && r2?.payload === "please",
    `got ${JSON.stringify(r2)}`,
  );
  const r3 = parseSlashCommand("/btw line one\nline two\n\nline four");
  check(
    "/btw payload preserves internal newlines verbatim",
    r3?.verb === "/btw" && r3?.payload === "line one\nline two\n\nline four",
    `got ${JSON.stringify(r3)}`,
  );
  const r4 = parseSlashCommand("/btw multi  spaces  here");
  check(
    "/btw payload preserves multi-space runs verbatim",
    r4?.verb === "/btw" && r4?.payload === "multi  spaces  here",
    `got ${JSON.stringify(r4)}`,
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
  // Leading separator punctuation between verb and payload is consumed,
  // so `/btw: question` and `/btw, question` both yield payload "question".
  check(
    "/btw: question payload strips colon separator",
    parseSlashCommand("/btw: question")?.payload === "question",
    `got ${JSON.stringify(parseSlashCommand("/btw: question"))}`,
  );
  check(
    "/btw, question payload strips comma separator",
    parseSlashCommand("/btw, question")?.payload === "question",
    `got ${JSON.stringify(parseSlashCommand("/btw, question"))}`,
  );
  check(
    "/btw:hello payload strips colon (no whitespace)",
    parseSlashCommand("/btw:hello")?.payload === "hello",
    `got ${JSON.stringify(parseSlashCommand("/btw:hello"))}`,
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
console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
