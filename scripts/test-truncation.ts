// Direct unit test for sendOrAttach truncation path with mention preservation.
// We don't actually POST to Discord — we stub channel.send() and inspect what
// would have been sent. Verifies: truncation, mention-tail preservation, and
// the "no file upload ever" invariant.

import { BotInstance } from "../src/bot-instance.js";

// Minimal fake BotInstance options
const dummyHandler = async () => {};
const bot = new BotInstance({
  displayName: "TestBot",
  knownBotIds: new Set<string>(),
  handler: dummyHandler,
  textMentionPattern: /@testbot/i,
});

// Fake channel that captures what .send() receives
interface SentPayload {
  content?: string;
  files?: unknown[];
}
const sent: SentPayload[] = [];
const fakeChannel = {
  send: async (arg: unknown) => {
    if (typeof arg === "string") {
      sent.push({ content: arg });
    } else {
      sent.push(arg as SentPayload);
    }
  },
};

async function run() {
  const MENTION_QWEN = "<@1492936472255533167>";
  const MENTION_ROLE = "<@&1492942076340342930>";

  // ----- Test 1: short message sends inline as-is -----
  sent.length = 0;
  await bot.sendOrAttach(fakeChannel as any, "hello world");
  console.log("Test 1 (short):");
  console.log("  payload:", JSON.stringify(sent[0]));
  if (sent[0]?.content === "hello world" && !sent[0]?.files) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
  }

  // ----- Test 2: long message with no mentions → truncated, no files -----
  sent.length = 0;
  const longText = "a".repeat(3000);
  await bot.sendOrAttach(fakeChannel as any, longText);
  console.log("\nTest 2 (long, no mentions):");
  console.log("  payload length:", sent[0]?.content?.length);
  console.log("  tail:", JSON.stringify(sent[0]?.content?.slice(-120)));
  console.log("  files present?:", !!sent[0]?.files);
  if (
    sent[0]?.content &&
    sent[0].content.length <= 1900 &&
    sent[0].content.includes("[truncated") &&
    !sent[0].files
  ) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
  }

  // ----- Test 3: long message with mention past truncation → tail preserves it -----
  sent.length = 0;
  const preamble = "x".repeat(2500); // pushes past truncation
  const withMention = `${preamble} please ${MENTION_QWEN} acknowledge this`;
  await bot.sendOrAttach(fakeChannel as any, withMention);
  console.log("\nTest 3 (long with mention past truncation):");
  console.log("  payload length:", sent[0]?.content?.length);
  console.log("  tail:", JSON.stringify(sent[0]?.content?.slice(-200)));
  console.log("  contains Qwen mention in tail?:", sent[0]?.content?.includes(MENTION_QWEN));
  console.log("  files present?:", !!sent[0]?.files);
  if (
    sent[0]?.content?.includes(MENTION_QWEN) &&
    !sent[0].files
  ) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
  }

  // ----- Test 4: long message with mention inside truncation window (dedup) -----
  sent.length = 0;
  const earlyMention = `${MENTION_ROLE} please do this task\n` + "y".repeat(3000);
  await bot.sendOrAttach(fakeChannel as any, earlyMention);
  console.log("\nTest 4 (mention inside truncation window, dedup check):");
  const occ4 = (sent[0]?.content?.match(new RegExp(MENTION_ROLE.replace(/[()]/g, "\\$&"), "g")) ?? []).length;
  console.log("  mention occurrences in output:", occ4);
  console.log("  files present?:", !!sent[0]?.files);
  if (occ4 === 1 && !sent[0]?.files) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
  }

  // ----- Test 5: caller mention prefix included -----
  sent.length = 0;
  await bot.sendOrAttach(fakeChannel as any, "a".repeat(3000), { mention: MENTION_QWEN });
  console.log("\nTest 5 (caller mention prefix on truncated):");
  console.log("  starts with caller mention?:", sent[0]?.content?.startsWith(MENTION_QWEN));
  console.log("  files present?:", !!sent[0]?.files);
  if (sent[0]?.content?.startsWith(MENTION_QWEN) && !sent[0]?.files) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
  }

  console.log("\nAll 5 tests complete.");
  process.exit(0);
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
