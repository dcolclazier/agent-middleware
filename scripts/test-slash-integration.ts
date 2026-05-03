// Integration smoketest for the Discord-side slash dispatch (issue #25).
//
// PR #16 shipped /cancel and /end with strong UNIT coverage:
//
//   scripts/test-slash-commands.ts  — 43 assertions on the pure parser
//   scripts/test-cancel-turn.ts     — 25 assertions on cancelTurn() against
//                                     a node-running-hang-script Claude stub
//
// What was NOT exercised: the FULL path from a Discord message body through
// the per-bot handler — `claudeHandler` in src/discord-bot.ts — into slash
// dispatch → runner-level cancellation / mapping clear → reaction emit.
// PR #16's review flagged this as test debt (issue #25). This script closes
// it.
//
// We test at the `claudeHandler` boundary, not all the way from
// `BotInstance.handleMessage`. Per the brief on #25, the handler-level seam
// is what needs coverage; `handleMessage`'s mention/strip/kill-switch logic
// is upstream of slash dispatch and stable. The Message stub only provides
// what `claudeHandler` actually touches — `.react(emoji)` plus the
// author/id surface used when the resume path falls through to a new-session
// spawn (Test 4 deliberately stays on the resume-existing-session path so
// none of that fires).
//
// Run: npx tsx scripts/test-slash-integration.ts

import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Message } from "discord.js";

// --- Test harness setup ---
//
// Mirror scripts/test-cancel-turn.ts: configure CLAUDE_BIN to `node` running
// a tiny hang-forever script BEFORE importing claude-runner so the runner
// reads the env at module init. Same fake stream-json init line so the
// runner captures a deterministic claudeSessionId we can assert against.

const tmpDir = mkdtempSync(join(tmpdir(), "slash-integration-"));
const hangScript = join(tmpDir, "hang.js");
writeFileSync(
  hangScript,
  `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"FAKE-SESSION-ID-12345"}) + "\\n");\nsetInterval(() => {}, 60000);\n`,
);

process.env.CLAUDE_BIN = "node";
process.env.CLAUDE_BIN_PREFIX_ARG = hangScript;
process.env.CLAUDE_CWD = tmpDir;
// Isolate persistence — same reasoning as test-cancel-turn.ts: without this
// override, createSession() → saveSessions() writes the FAKE-SESSION fixture
// into the repo-local sessions.json.
process.env.CLAUDE_SESSIONS_FILE = join(tmpDir, "sessions.json");

// Imports must come AFTER env setup. claude-runner reads CLAUDE_BIN /
// CLAUDE_CWD / CLAUDE_SESSIONS_FILE at module init.
const runner = await import("../src/claude-runner.js");
const { createSession, getSession, cancelTurn } = runner;
const { claudeHandler } = await import("../src/discord-bot.js");
const { BotInstance } = await import("../src/bot-instance.js");
import type { TriggerRef } from "../src/bot-instance.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "predicate",
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(25);
  }
  console.log(`    waitFor(${label}) timed out after ${timeoutMs}ms`);
  return false;
}

// --- Discord stubs ---
//
// claudeHandler touches `message.react(emoji)` (via its safeReact helper)
// for every slash-command branch. The non-slash resume branch additionally
// calls `message.react("🤔")`. Nothing else is read off the Message in the
// paths we exercise (Test 4 hits the existing-session resume branch, so the
// new-session create branch — which reads `message.author.username` etc. —
// stays out of scope).
//
// We model the stub as a closure over a `reactions: string[]` array so each
// test can assert on the emojis emitted in order.

interface StubMessage {
  reactions: string[];
  message: Message;
}

function makeStubMessage(): StubMessage {
  const reactions: string[] = [];
  const stub = {
    react: async (emoji: string) => {
      reactions.push(emoji);
      // discord.js' .react resolves with a MessageReaction; tests don't
      // observe it, so a typed cast on the way out is sufficient.
      return undefined as unknown;
    },
  };
  return { reactions, message: stub as unknown as Message };
}

function makeTrigger(channelId: string, messageId: string): TriggerRef {
  return {
    channelId,
    messageId,
    authorId: "test-author",
    authorIsBot: false,
  };
}

function makeBot(): BotInstance {
  // BotInstance is constructable without a Discord client; only `start()`
  // creates one. We exercise the synchronous channel/trigger bookkeeping
  // (set/get/clear) which lives entirely in the in-memory Maps.
  return new BotInstance({
    displayName: "TestClaudeCode",
    knownBotIds: new Set<string>(),
    handler: claudeHandler,
  });
}

try {
  // -------------------------------------------------------------------------
  // Test 1: /cancel happy path
  //
  // Brief AC2 (partial — follow-up resume is in Test 4): a /cancel against a
  // running session must react 💀, preserve the channel→Session mapping, and
  // preserve the captured claudeSessionId so the next message can resume.
  // -------------------------------------------------------------------------
  sect("1. /cancel happy path: 💀 + mapping preserved + claudeSessionId preserved");
  {
    const channelId = "channel-1";
    const bot = makeBot();
    const session = createSession("hello", false, false, null);

    // Wait for the hang script's init line to land so claudeSessionId is set.
    await waitFor(
      () => getSession(session.id)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "claudeSessionId captured",
    );
    bot.setSessionForChannel(channelId, session.id);
    bot.setTrigger(session.id, makeTrigger(channelId, "msg-1"));

    const stub = makeStubMessage();
    const trigger = makeTrigger(channelId, "msg-cancel");
    await claudeHandler(bot, stub.message, "/cancel", trigger, []);

    check(
      "💀 reaction emitted on the /cancel message",
      stub.reactions.length === 1 && stub.reactions[0] === "💀",
      `got ${JSON.stringify(stub.reactions)}`,
    );
    check(
      "channel→Session mapping preserved (cancel does not drop it)",
      bot.getSessionForChannel(channelId) === session.id,
      `got ${bot.getSessionForChannel(channelId)}`,
    );
    check(
      "claudeSessionId still pinned (so next message can --resume)",
      getSession(session.id)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      `got ${getSession(session.id)?.claudeSessionId}`,
    );

    // Tear down so the close handler fires before the next test.
    await waitFor(
      () => getSession(session.id)?.process === null,
      2000,
      "process torn down",
    );
  }

  // -------------------------------------------------------------------------
  // Test 2: /cancel no-op
  //
  // Brief AC3: when the channel's session has no in-flight subprocess, the
  // /cancel message reacts ⚠️ instead of 💀. We force the no-op shape by
  // cancelling the session at the runner level first, waiting for the close
  // handler, then driving claudeHandler with /cancel.
  // -------------------------------------------------------------------------
  sect("2. /cancel no-op: ⚠️ when session is idle");
  {
    const channelId = "channel-2";
    const bot = makeBot();
    const session = createSession("hello", false, false, null);
    await waitFor(
      () => getSession(session.id)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "init captured",
    );
    bot.setSessionForChannel(channelId, session.id);

    // Force the session into the idle / no-process state before /cancel.
    cancelTurn(session.id);
    await waitFor(
      () => getSession(session.id)?.process === null,
      2000,
      "process torn down",
    );

    const stub = makeStubMessage();
    const trigger = makeTrigger(channelId, "msg-cancel-noop");
    await claudeHandler(bot, stub.message, "/cancel", trigger, []);

    check(
      "⚠️ reaction emitted on the no-op /cancel",
      stub.reactions.length === 1 && stub.reactions[0] === "⚠️",
      `got ${JSON.stringify(stub.reactions)}`,
    );
    check(
      "channel mapping unchanged on no-op (cancel only clears on /end)",
      bot.getSessionForChannel(channelId) === session.id,
      `got ${bot.getSessionForChannel(channelId)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Test 3: /end happy path
  //
  // Brief AC4: /end reacts 👋, clears channel→Session mapping, clears the
  // trigger, and sets suppressDiscordPost on the Session record.
  // -------------------------------------------------------------------------
  sect("3. /end happy path: 👋 + mapping cleared + trigger cleared + suppressDiscordPost");
  {
    const channelId = "channel-3";
    const bot = makeBot();
    const session = createSession("hello", false, false, null);
    await waitFor(
      () => getSession(session.id)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "init captured",
    );
    bot.setSessionForChannel(channelId, session.id);
    bot.setTrigger(session.id, makeTrigger(channelId, "msg-prior"));

    const stub = makeStubMessage();
    const trigger = makeTrigger(channelId, "msg-end");
    await claudeHandler(bot, stub.message, "/end", trigger, []);

    check(
      "👋 reaction emitted on the /end message",
      stub.reactions.length === 1 && stub.reactions[0] === "👋",
      `got ${JSON.stringify(stub.reactions)}`,
    );
    check(
      "channel→Session mapping cleared (channel is dissociated)",
      bot.getSessionForChannel(channelId) === undefined,
      `got ${bot.getSessionForChannel(channelId)}`,
    );
    check(
      "trigger cleared (no leak via sessionTriggers)",
      bot.getTrigger(session.id) === undefined,
      `got ${JSON.stringify(bot.getTrigger(session.id))}`,
    );
    check(
      "suppressDiscordPost set on the Session (belt-and-braces vs cancelTurn race)",
      getSession(session.id)?.suppressDiscordPost === true,
      `got ${getSession(session.id)?.suppressDiscordPost}`,
    );

    await waitFor(
      () => getSession(session.id)?.process === null,
      2000,
      "process torn down",
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: post-cancel follow-up resumes the SAME session
  //
  // Brief AC5 (regression — "iter-2 post-cancel queue drain") + the AC2
  // tail ("follow-up message resumes same Claude session id"). We deliver
  // /cancel and a non-slash follow-up through claudeHandler back-to-back,
  // and assert the channel→Session mapping and the captured claudeSessionId
  // both survive — i.e. the follow-up rides the same Claude conversation
  // via the runner's --resume path rather than falling through to a fresh
  // createSession.
  //
  // We DO NOT pin the timing of the post-cancel send (running-vs-idle
  // when the second handler call lands). The runner's queue-drain unit
  // test (test-cancel-turn.ts §4) already pins the SIGTERM→close window
  // path; here, the integration-level invariant is just "same session
  // resumes regardless of which branch the runner took."
  // -------------------------------------------------------------------------
  sect("4. post-cancel follow-up via claudeHandler resumes the SAME session");
  {
    const channelId = "channel-4";
    const bot = makeBot();
    const session = createSession("first turn", false, false, null);
    await waitFor(
      () => getSession(session.id)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "init captured",
    );
    bot.setSessionForChannel(channelId, session.id);
    bot.setTrigger(session.id, makeTrigger(channelId, "msg-prior"));

    const preCancelProc = getSession(session.id)?.process;
    check(
      "pre-cancel process is non-null (a real subprocess is in flight)",
      preCancelProc !== null && preCancelProc !== undefined,
    );

    // /cancel via claudeHandler.
    const cancelStub = makeStubMessage();
    const cancelTrigger = makeTrigger(channelId, "msg-cancel");
    await claudeHandler(bot, cancelStub.message, "/cancel", cancelTrigger, []);
    check(
      "💀 on the /cancel message",
      cancelStub.reactions[0] === "💀",
      `got ${JSON.stringify(cancelStub.reactions)}`,
    );

    // Wait for the close handler to fire so the next claudeHandler call
    // hits a deterministic "session.status === 'idle', process === null"
    // state. (The race-window path is covered by test-cancel-turn.ts §4.)
    await waitFor(
      () => getSession(session.id)?.process === null,
      2000,
      "post-cancel tear-down",
    );

    // Non-slash follow-up via claudeHandler. Existing-session resume branch
    // → sendMessage(existingSessionId, content) → 🤔 react. The runner
    // re-spawns because the session is idle with claudeSessionId pinned.
    const followStub = makeStubMessage();
    const followTrigger = makeTrigger(channelId, "msg-follow");
    await claudeHandler(bot, followStub.message, "follow up please", followTrigger, []);

    check(
      "🤔 on the follow-up (existing-session sendMessage branch)",
      followStub.reactions[0] === "🤔",
      `got ${JSON.stringify(followStub.reactions)}`,
    );
    check(
      "channel→Session mapping unchanged (no fresh createSession)",
      bot.getSessionForChannel(channelId) === session.id,
      `got ${bot.getSessionForChannel(channelId)}`,
    );

    // Wait for the resume re-spawn so we can assert the new process is
    // running and the claudeSessionId is still pinned to the original
    // FAKE id (the runner's --resume path preserves it).
    await waitFor(
      () => {
        const s = getSession(session.id);
        return s?.process !== null && s?.process !== preCancelProc && s?.status === "running";
      },
      3000,
      "post-cancel resume re-spawned",
    );
    const after = getSession(session.id)!;
    check(
      "resume produced a NEW process (not the cancelled one)",
      after.process !== preCancelProc,
    );
    check(
      "status is 'running' on the resumed turn",
      after.status === "running",
      `got ${after.status}`,
    );
    check(
      "claudeSessionId still pinned through the post-cancel resume",
      after.claudeSessionId === "FAKE-SESSION-ID-12345",
      `got ${after.claudeSessionId}`,
    );
    check(
      "trigger re-bound to the follow-up message id",
      bot.getTrigger(session.id)?.messageId === "msg-follow",
      `got ${JSON.stringify(bot.getTrigger(session.id))}`,
    );

    // Tear down.
    cancelTurn(session.id);
    await waitFor(
      () => getSession(session.id)?.process === null,
      2000,
      "final teardown",
    );
  }
} finally {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
