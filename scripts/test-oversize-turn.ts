// Unit tests for oversized-turn handling at the Discord routing layer.
//
// We exercise both branches of the asymmetry from issue #5:
//   - Human + over the per-turn token budget → reject in-channel and abort
//     the per-bot handler.
//   - Bot + over the per-turn token budget → truncate to ~90% of the budget,
//     append a [truncated] marker, post a one-line warning, and continue.
//
// Two layers of coverage:
//   1. Pure decision function `evaluateTurnSize(body, isBot)` exercised
//      directly with synthetic strings.
//   2. The `applyOversizeTurnPolicy` BotInstance method exercised against a
//      stub channel so we can assert what would have been sent without
//      booting Discord.
//
// Run: npx tsx scripts/test-oversize-turn.ts
//      (also wired up as `npm run smoketest:oversize-turn`).

import {
  BotInstance,
  TURN_BUDGET,
  evaluateTurnSize,
  splitLeadingAttachmentBlocks,
} from "../src/bot-instance.js";
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

// Build a string that estimates to roughly `targetTokens` tokens. cl100k_base
// runs at ~1 token per ~3-4 chars for ASCII letters, so we generate a generous
// repeating filler and verify with `estimateTokens` after the fact.
function bodyOfTokens(targetTokens: number): string {
  // Use a varied string so tiktoken doesn't collapse repeats into one token.
  // "alpha bravo charlie delta echo " is ~30 chars, ~6 tokens.
  const seed = "alpha bravo charlie delta echo ";
  // Overshoot by 50% then trim back by char count if needed.
  const repeats = Math.ceil((targetTokens / 6) * 1.5);
  let s = seed.repeat(repeats);
  // Walk back if we're too long (shouldn't happen, but safe).
  while (estimateTokens(s) > targetTokens * 1.6 && s.length > 100) {
    s = s.slice(0, Math.floor(s.length * 0.9));
  }
  return s;
}

// -----------------------------------------------------------------------
// 1. Pure decision: small bodies pass through
// -----------------------------------------------------------------------
sect("1. pure: under-budget bodies pass through");
{
  const dHuman = evaluateTurnSize("hello world", false);
  check("human under: ok", dHuman.kind === "ok");

  const dBot = evaluateTurnSize("hello world", true);
  check("bot under: ok", dBot.kind === "ok");

  check(
    "TURN_BUDGET is the documented 22_000",
    TURN_BUDGET === 22_000,
    `got: ${TURN_BUDGET}`,
  );
}

// -----------------------------------------------------------------------
// 2. Pure decision: human + over → reject_human with token counts
// -----------------------------------------------------------------------
sect("2. pure: human + over → reject_human");
{
  const big = bodyOfTokens(30_000);
  const tokens = estimateTokens(big);
  check("test fixture is over budget", tokens > TURN_BUDGET, `tokens=${tokens}`);

  const d = evaluateTurnSize(big, false);
  check("kind is reject_human", d.kind === "reject_human");
  if (d.kind === "reject_human") {
    check("reports token count", d.tokens === tokens, `got: ${d.tokens}`);
    check("reports the limit", d.limit === TURN_BUDGET);
  }
}

// -----------------------------------------------------------------------
// 3. Pure decision: bot + over → truncate_bot with ~90% body
// -----------------------------------------------------------------------
sect("3. pure: bot + over → truncate_bot");
{
  const big = bodyOfTokens(30_000);
  const tokens = estimateTokens(big);

  const d = evaluateTurnSize(big, true);
  check("kind is truncate_bot", d.kind === "truncate_bot");
  if (d.kind === "truncate_bot") {
    check("originalTokens matches input", d.originalTokens === tokens);
    // Truncated body should sit at or under TURN_BUDGET * 0.9 = 19_800,
    // with a small slack for the appended [truncated] marker.
    const cap = Math.floor(TURN_BUDGET * 0.9);
    check(
      "truncatedTokens at or under 90% of TURN_BUDGET (+ small marker slack)",
      d.truncatedTokens <= cap + 32,
      `got: ${d.truncatedTokens}, cap: ${cap}`,
    );
    check(
      "truncatedTokens still smaller than originalTokens",
      d.truncatedTokens < d.originalTokens,
    );
    check(
      "truncated body ends with [truncated] marker",
      d.truncatedBody.includes("[truncated]"),
      `tail: ${JSON.stringify(d.truncatedBody.slice(-40))}`,
    );
    check(
      "truncated body shorter than original",
      d.truncatedBody.length < big.length,
    );
  }
}

// -----------------------------------------------------------------------
// 4. applyOversizeTurnPolicy — wiring layer: human-over path
//    sends a one-line reply naming the limit and aborts the handler.
// -----------------------------------------------------------------------
sect("4. wiring: human + over → channel reply, abort=true");
{
  const handlerCalls: number[] = [];
  const dummyHandler = async () => {
    handlerCalls.push(1);
  };
  const bot = new BotInstance({
    displayName: "TestBot",
    knownBotIds: new Set<string>(),
    handler: dummyHandler,
    textMentionPattern: /@testbot/i,
  });

  interface SentPayload {
    content?: string;
  }
  const sent: SentPayload[] = [];
  const fakeChannel = {
    send: async (arg: unknown) => {
      if (typeof arg === "string") sent.push({ content: arg });
      else sent.push(arg as SentPayload);
    },
  };

  const big = bodyOfTokens(30_000);
  const result = await bot.applyOversizeTurnPolicy(
    fakeChannel as any,
    big,
    /* isBot */ false,
    /* authorName */ "alice",
  );

  check("decision: abort=true", result.abort === true);
  check("exactly one channel send", sent.length === 1, `sent=${sent.length}`);
  check(
    "reply mentions the limit (TURN_BUDGET)",
    !!sent[0]?.content?.includes(String(TURN_BUDGET)),
    `content: ${sent[0]?.content}`,
  );
  check(
    "reply suggests chunk or attach",
    !!sent[0]?.content && /chunk|attach|file/i.test(sent[0].content),
    `content: ${sent[0]?.content}`,
  );
  check("handler is not invoked separately", handlerCalls.length === 0);
}

// -----------------------------------------------------------------------
// 5. applyOversizeTurnPolicy — wiring layer: bot-over path
//    truncates body, posts a warning, returns abort=false + truncated body.
// -----------------------------------------------------------------------
sect("5. wiring: bot + over → warning posted, abort=false, body truncated");
{
  const bot = new BotInstance({
    displayName: "TestBot",
    knownBotIds: new Set<string>(),
    handler: async () => {},
    textMentionPattern: /@testbot/i,
  });

  interface SentPayload {
    content?: string;
  }
  const sent: SentPayload[] = [];
  const fakeChannel = {
    send: async (arg: unknown) => {
      if (typeof arg === "string") sent.push({ content: arg });
      else sent.push(arg as SentPayload);
    },
  };

  const big = bodyOfTokens(30_000);
  const originalTokens = estimateTokens(big);

  const result = await bot.applyOversizeTurnPolicy(
    fakeChannel as any,
    big,
    /* isBot */ true,
    /* authorName */ "NemoClaw",
  );

  check("decision: abort=false (handler still runs)", result.abort === false);
  check("returns truncated body", result.body.length < big.length);
  check("truncated body has marker", result.body.includes("[truncated]"));
  check(
    "truncated body fits within ~90% of TURN_BUDGET (+ marker slack)",
    estimateTokens(result.body) <= Math.floor(TURN_BUDGET * 0.9) + 32,
  );
  check("exactly one warning sent", sent.length === 1);
  check(
    "warning identifies the originating bot by name",
    !!sent[0]?.content?.includes("NemoClaw"),
    `content: ${sent[0]?.content}`,
  );
  check(
    "warning includes the original token count",
    !!sent[0]?.content?.includes(String(originalTokens)),
    `content: ${sent[0]?.content}; expected: ${originalTokens}`,
  );
  check(
    "warning includes the truncated-to token count",
    !!sent[0]?.content?.includes(String(estimateTokens(result.body))),
    `content: ${sent[0]?.content}`,
  );
  check(
    "warning uses the truncated wording",
    /trunc/i.test(sent[0]?.content ?? ""),
    `content: ${sent[0]?.content}`,
  );
}

// -----------------------------------------------------------------------
// 6. applyOversizeTurnPolicy — under budget: noop pass-through
// -----------------------------------------------------------------------
sect("6. wiring: under budget → no send, body unchanged, abort=false");
{
  const bot = new BotInstance({
    displayName: "TestBot",
    knownBotIds: new Set<string>(),
    handler: async () => {},
    textMentionPattern: /@testbot/i,
  });

  const sent: any[] = [];
  const fakeChannel = {
    send: async (arg: unknown) => {
      sent.push(arg);
    },
  };

  const small = "small body, definitely under 22k tokens";
  const r1 = await bot.applyOversizeTurnPolicy(
    fakeChannel as any,
    small,
    false,
    "alice",
  );
  check("no channel send for human under", sent.length === 0);
  check("abort=false", r1.abort === false);
  check("body untouched", r1.body === small);

  const r2 = await bot.applyOversizeTurnPolicy(
    fakeChannel as any,
    small,
    true,
    "OtherBot",
  );
  check("no channel send for bot under", sent.length === 0);
  check("abort=false (bot under)", r2.abort === false);
  check("body untouched (bot under)", r2.body === small);
}

// -----------------------------------------------------------------------
// 7. Attachment content is INCLUDED in the size measurement.
//    The body parameter is the concatenated prompt the per-bot handler will
//    see — qwen-bot.ts and discord-bot.ts already prepend
//    [ATTACHMENT: …] blocks. We confirm here that a human prompt that's
//    safely tiny on its own becomes oversized once an attachment is folded
//    in, and that triggers the human-reject branch — i.e. attachments do
//    NOT bypass the cap.
// -----------------------------------------------------------------------
sect("7. attachments included in size measurement");
{
  const tinyText = "please summarise the attached file";
  check(
    "tiny prompt alone is under budget",
    estimateTokens(tinyText) < TURN_BUDGET,
  );

  const huge = bodyOfTokens(30_000);
  const attachmentBlock = `[ATTACHMENT: dump.txt]\n${huge}\n[/ATTACHMENT]`;
  const fullBody = `${attachmentBlock}\n\n${tinyText}`;

  const d = evaluateTurnSize(fullBody, false);
  check(
    "human + huge attachment → reject_human (attachment counts)",
    d.kind === "reject_human",
  );
}

// -----------------------------------------------------------------------
// 8. splitLeadingAttachmentBlocks — re-splitting the truncated body
//    into (content, attachments) so the per-bot handler's invariant
//    (directive detection runs on un-prepended content) survives the
//    truncation path. Exercises the boundary check, mid-attachment
//    truncation, and marker stripping.
// -----------------------------------------------------------------------
sect("8. splitLeadingAttachmentBlocks: clean two-attachment body");
{
  const body =
    `[ATTACHMENT: a.md]\nalpha content\n[/ATTACHMENT]\n\n` +
    `[ATTACHMENT: b.txt]\nbravo content\n[/ATTACHMENT]\n\n` +
    `the prose lives here`;
  const split = splitLeadingAttachmentBlocks(body);
  check("returns 2 attachments", split.attachments.length === 2);
  check("first attachment name", split.attachments[0]?.name === "a.md");
  check(
    "first attachment content (verbatim, no markers)",
    split.attachments[0]?.content === "alpha content",
  );
  check("second attachment name", split.attachments[1]?.name === "b.txt");
  check(
    "second attachment content (verbatim)",
    split.attachments[1]?.content === "bravo content",
  );
  check(
    "trailing prose preserved",
    split.content === "the prose lives here",
  );
}

sect("9. splitLeadingAttachmentBlocks: no attachments → pass-through");
{
  const split = splitLeadingAttachmentBlocks("just some prose with no markers");
  check("zero attachments", split.attachments.length === 0);
  check(
    "content equals input",
    split.content === "just some prose with no markers",
  );
}

sect("10. splitLeadingAttachmentBlocks: boundary check skips embedded close");
{
  // The attachment content itself contains "\n[/ATTACHMENT]" not followed
  // by a "\n\n" or end-of-string boundary. The parser must skip it and
  // find the REAL close that does have the boundary.
  const body =
    `[ATTACHMENT: doc.md]\n` +
    `documenting the format: line ends with [/ATTACHMENT] tag here\n` +
    `but the content continues here\n` +
    `[/ATTACHMENT]\n\n` +
    `prose tail`;
  const split = splitLeadingAttachmentBlocks(body);
  check("found exactly one attachment", split.attachments.length === 1);
  check(
    "attachment content includes the embedded false-positive line",
    split.attachments[0]?.content.includes(
      "documenting the format: line ends with [/ATTACHMENT] tag here",
    ) ?? false,
    `got: ${JSON.stringify(split.attachments[0]?.content?.slice(0, 200))}`,
  );
  check(
    "attachment content includes the continuation line",
    split.attachments[0]?.content.includes("but the content continues here") ??
      false,
  );
  check("trailing prose extracted", split.content === "prose tail");
}

sect("11. splitLeadingAttachmentBlocks: truncation cut mid-attachment");
{
  // Simulate a truncated body that cut mid-attachment, with the
  // TURN_TRUNCATE_MARKER appended to the whole. The marker MUST NOT end
  // up inside attachment.content.
  const body =
    `[ATTACHMENT: huge.log]\n` +
    `partial content that was cut off here` +
    `\n\n[truncated]`;
  const split = splitLeadingAttachmentBlocks(body);
  check("one partial attachment recovered", split.attachments.length === 1);
  check(
    "partial attachment name preserved",
    split.attachments[0]?.name === "huge.log",
  );
  check(
    "marker NOT smuggled into attachment.content",
    !(split.attachments[0]?.content.includes("[truncated]") ?? false),
    `got: ${JSON.stringify(split.attachments[0]?.content?.slice(-60))}`,
  );
  check(
    "partial content preserved up to the cut",
    split.attachments[0]?.content === "partial content that was cut off here",
  );
  check(
    "marker preserved as trailing content",
    split.content.includes("[truncated]"),
    `content: ${JSON.stringify(split.content)}`,
  );
}

sect("12. splitLeadingAttachmentBlocks: end-of-string after close");
{
  // No trailing prose at all — body ends right after the last [/ATTACHMENT].
  // The boundary check must accept end-of-string as a valid close.
  const body = `[ATTACHMENT: only.md]\nlone attachment\n[/ATTACHMENT]`;
  const split = splitLeadingAttachmentBlocks(body);
  check("one attachment", split.attachments.length === 1);
  check(
    "attachment content extracted",
    split.attachments[0]?.content === "lone attachment",
  );
  check("no trailing content", split.content === "");
}

// -----------------------------------------------------------------------
console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
