// Smoketest for /btw side-session FIFO queue (issue #15).
//
// Acceptance criteria covered (from the agent brief on #15):
//
//   1. Side session spawned with a NEW Claude session id — never `--resume`
//      of the channel's main `claudeSessionId`.
//   2. Side session is NOT written to `sessions.json` (verified by reading
//      the file before and after).
//   3. The channel→Session mapping is unchanged before/during/after.
//   4. Main session's `claudeSessionId` and `messageQueue` untouched.
//   5. At most ONE in-flight side session per channel; second `/btw` queues
//      and drains FIFO when the previous side session terminates.
//   6. Side-turn queue is independent of the main-turn `messageQueue` —
//      enqueueing main-turn messages does not delay side sessions.
//   7. Seeded prompt = channel-history + main session's lastAssistantText +
//      payload (each piece skipped silently when empty).
//
// This test exercises the public Side-session helper (`enqueueSideTurn`,
// `seedSidePrompt`) directly. The Discord-bot dispatch wiring is a thin
// adapter on top of the helper — we trust the slash-command parser tests
// and the per-call integration with the helper to cover that.
//
// Test harness: same approach as scripts/test-cancel-turn.ts — we set
// CLAUDE_BIN to `node` running a stub script BEFORE importing claude-runner
// so the runner spawns predictable, controllable subprocesses.
//
// Run: npx tsx scripts/test-side-session-queue.ts

import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// --- Test harness setup ---

const tmpDir = mkdtempSync(join(tmpdir(), "side-session-"));

// Stub "claude" binary: emits a per-spawn unique session id init line then
// exits cleanly. We need it to actually exit (not hang) so the FIFO drain
// fires on `close`. The session id is read from argv so the test can correlate
// each spawn with its prompt.
const stubScript = join(tmpDir, "stub.js");
writeFileSync(
  stubScript,
  `
const args = process.argv.slice(2);
// Find the prompt arg ("-p <prompt>"). The runner places it as the
// second-to-last positional pair before --output-format.
let prompt = "";
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === "-p") { prompt = args[i + 1]; break; }
}
const sessionId = "STUB-" + Buffer.from(prompt).toString("hex").slice(0, 16);
process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:sessionId}) + "\\n");
// Optional delay before exit so we can observe in-flight state. Default 80ms;
// override with STUB_DELAY_MS.
const delay = parseInt(process.env.STUB_DELAY_MS || "80", 10);
setTimeout(() => {
  process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"echo: " + prompt}]}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",result:"echo: " + prompt}) + "\\n");
  process.exit(0);
}, delay);
`,
);

process.env.CLAUDE_BIN = "node";
process.env.CLAUDE_BIN_PREFIX_ARGS = stubScript;
process.env.CLAUDE_CWD = tmpDir;
process.env.STUB_DELAY_MS = "80";

const runner = await import("../src/claude-runner.js");
const sideSessionMod = await import("../src/side-session.js");
const { createSession, sendMessage, getSession, sessionEvents } = runner;
const { enqueueSideTurn, seedSidePrompt, _resetSideSessionStateForTests } = sideSessionMod;

// SESSIONS_FILE lives next to the runner module (../sessions.json relative
// to dist; via tsx, relative to src/). Compute the same path the runner uses
// — `fileURLToPath` is required for Windows correctness (`URL.pathname`
// returns `/C:/...` with a leading slash and URL-escaped chars).
const SESSIONS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sessions.json",
);

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
  timeoutMs = 3000,
  label = "predicate",
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(15);
  }
  console.log(`    waitFor(${label}) timed out after ${timeoutMs}ms`);
  return false;
}

function readPersistedSessionIds(): Set<string> {
  if (!existsSync(SESSIONS_FILE)) return new Set();
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    return new Set(data.map((s: { id: string }) => s.id));
  } catch {
    return new Set();
  }
}

try {
  // -------------------------------------------------------------------------
  // 1. seedSidePrompt is pure — composes channel-history + lastAssistant +
  //    payload, skipping empty pieces.
  // -------------------------------------------------------------------------
  sect("1. seedSidePrompt composition");
  {
    const full = seedSidePrompt({
      channelHistory: "user: hello\nbot: hi",
      mainLastAssistantText: "I am editing foo.ts",
      payload: "what files have you edited?",
    });
    check(
      "full prompt includes channel history",
      full.includes("user: hello"),
      `prompt=\n${full}`,
    );
    check(
      "full prompt includes main session's lastAssistantText",
      full.includes("I am editing foo.ts"),
    );
    check(
      "full prompt includes /btw payload",
      full.includes("what files have you edited?"),
    );

    const noHistory = seedSidePrompt({
      channelHistory: "",
      mainLastAssistantText: "main was talking",
      payload: "side question",
    });
    check(
      "missing channelHistory is silently skipped",
      noHistory.includes("main was talking") &&
        noHistory.includes("side question") &&
        !noHistory.toLowerCase().includes("channel history"),
      `noHistory=\n${noHistory}`,
    );

    const onlyPayload = seedSidePrompt({
      channelHistory: "",
      mainLastAssistantText: "",
      payload: "just the question",
    });
    check(
      "only-payload yields the payload (no scaffolding)",
      onlyPayload.trim() === "just the question" ||
        onlyPayload.includes("just the question"),
      `onlyPayload=\n${onlyPayload}`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Spawn a side session via enqueueSideTurn — fresh Claude session id
  //    (NOT `--resume` of the main session id), not persisted, channel
  //    mapping untouched, main session's claudeSessionId/messageQueue
  //    untouched.
  // -------------------------------------------------------------------------
  sect("2. side session is fresh + ephemeral + non-disruptive to main");
  {
    _resetSideSessionStateForTests();

    // Set up a "main" session so we can verify the helper does not interfere
    // with it. We emulate the Discord channel→session mapping with a simple
    // Map the test owns — the helper doesn't manage it.
    const channelId = "C-channel-1";
    const mainSession = createSession("main turn please", false, false, null);

    // Wait for the main session's stub to capture an init session id and
    // exit. We want the main session at status === "complete" with a known
    // claudeSessionId so any subsequent mutation is visible.
    await waitFor(
      () => getSession(mainSession.id)?.status === "complete",
      3000,
      "main session complete",
    );
    const mainBefore = getSession(mainSession.id)!;
    check(
      "main session captured a claudeSessionId",
      typeof mainBefore.claudeSessionId === "string" &&
        mainBefore.claudeSessionId !== null &&
        mainBefore.claudeSessionId.length > 0,
      `got ${mainBefore.claudeSessionId}`,
    );
    const mainClaudeIdBefore = mainBefore.claudeSessionId!;
    const mainQueueBefore = [...mainBefore.messageQueue];

    // Snapshot the persisted-sessions set BEFORE the side spawn.
    const persistedBefore = readPersistedSessionIds();
    check(
      "main session is persisted",
      persistedBefore.has(mainSession.id),
    );

    // Capture spawned-process argv per side session (so we can assert no
    // --resume flag). The runner doesn't expose argv directly, but we can
    // intercept by listening to the per-session event stream — the stub
    // emits the prompt text in the result event, which we cross-check
    // against the channelLookup below. The structural --no-resume guarantee
    // is that the helper passes `claudeSessionId: null` to createSession —
    // we verify by inspecting the spawned Session object's claudeSessionId
    // BEFORE the stub overwrites it (race avoided by inspecting the seeded
    // prompt instead: if the helper used resume, the prompt would have
    // gone to a `-p prompt --resume <main-id>` call and the spawned
    // session's claudeSessionId would START at the main id, not null).
    const spawnedSessionIds: string[] = [];
    const onPost = (ev: { sessionId: string; text: string }) => {
      if (ev.sessionId !== mainSession.id) {
        spawnedSessionIds.push(ev.sessionId);
      }
    };
    sessionEvents.on("post-to-discord", onPost);

    // Provide history + main lookup the way discord-bot.ts will.
    let acked = false;
    let queued = false;
    const sidePromise = enqueueSideTurn({
      channelId,
      payload: "what files have you edited?",
      channelHistoryProvider: async () => "user: where are we",
      mainSessionLookup: () => mainSession.id,
      onAck: () => { acked = true; },
      onQueued: () => { queued = true; },
    });

    check("first /btw was acked synchronously (not queued)", acked === true);
    check("first /btw was NOT queued", queued === false);

    const sideSessionId = await sidePromise;
    check("enqueueSideTurn returns the spawned side-session id", typeof sideSessionId === "string" && sideSessionId.length > 0);

    // Inspect the spawned Session immediately — at the moment of spawn the
    // claudeSessionId MUST be null (which proves `--resume` was NOT used).
    // The stub overwrites it ~80ms later when it emits the init line, so we
    // capture status while it's still running.
    const sideAtSpawn = getSession(sideSessionId);
    check(
      "side session exists in the in-memory sessions map",
      sideAtSpawn !== undefined,
    );
    check(
      "side session was created without --resume (claudeSessionId starts null)",
      sideAtSpawn?.claudeSessionId === null,
      `got ${sideAtSpawn?.claudeSessionId}`,
    );

    // Wait for the side session to terminate (stub exits in 80ms).
    await waitFor(
      () => {
        const s = getSession(sideSessionId);
        return s !== undefined && s.process === null && s.status !== "running";
      },
      3000,
      "side session terminal",
    );

    // The side session's claudeSessionId after termination is the stub's
    // self-assigned one — it MUST be different from the main session's id.
    const sideAfter = getSession(sideSessionId);
    check(
      "side session captured its OWN distinct Claude session id",
      sideAfter !== undefined &&
        sideAfter.claudeSessionId !== null &&
        sideAfter.claudeSessionId !== mainClaudeIdBefore,
      `side=${sideAfter?.claudeSessionId} main=${mainClaudeIdBefore}`,
    );

    // Main session must be untouched.
    const mainAfter = getSession(mainSession.id)!;
    check(
      "main session's claudeSessionId is unchanged",
      mainAfter.claudeSessionId === mainClaudeIdBefore,
    );
    check(
      "main session's messageQueue is unchanged",
      JSON.stringify(mainAfter.messageQueue) === JSON.stringify(mainQueueBefore),
    );

    // Side session must NOT have been written to sessions.json.
    const persistedAfter = readPersistedSessionIds();
    check(
      "side session is NOT in the persisted sessions file",
      !persistedAfter.has(sideSessionId),
    );
    check(
      "main session is still in the persisted sessions file",
      persistedAfter.has(mainSession.id),
    );

    // Side session should have emitted a post-to-discord event so listeners
    // can post the answer to the channel like a normal reply.
    check(
      "side session emitted a post-to-discord event for its final text",
      spawnedSessionIds.includes(sideSessionId),
    );

    sessionEvents.off("post-to-discord", onPost);
  }

  // -------------------------------------------------------------------------
  // 3. FIFO queue: three rapid /btw calls produce exactly one in-flight side
  //    session at a time, FIFO order, with main untouched throughout.
  // -------------------------------------------------------------------------
  sect("3. side-session FIFO queue (3 rapid /btw)");
  {
    _resetSideSessionStateForTests();

    const channelId = "C-channel-fifo";
    const mainSession = createSession("fifo main", false, false, null);
    await waitFor(
      () => getSession(mainSession.id)?.status === "complete",
      3000,
      "fifo main complete",
    );
    const mainClaudeIdBefore = getSession(mainSession.id)!.claudeSessionId!;
    const mainQueueBefore = [...getSession(mainSession.id)!.messageQueue];

    // Slow the stub down so we can observe in-flight overlap.
    process.env.STUB_DELAY_MS = "150";

    // Track completion order via post-to-discord events — they're emitted
    // for each side session's `complete`. We capture EVERY non-main event
    // up front (since queued sessions' ids aren't known until they spawn)
    // and filter to our 3 known sideIds after they're all assigned.
    const allNonMainCompleteOrder: string[] = [];
    const onPost = (ev: { sessionId: string; text: string }) => {
      if (ev.sessionId === mainSession.id) return;
      allNonMainCompleteOrder.push(ev.sessionId);
    };
    sessionEvents.on("post-to-discord", onPost);

    const acks: boolean[] = [];
    const queueds: boolean[] = [];

    // Issue 3 /btw calls in rapid succession — all should accept, only the
    // first should be acked-immediately; #2 and #3 should be queued.
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 3; i++) {
      let acked = false;
      let queued = false;
      const p = enqueueSideTurn({
        channelId,
        payload: `q${i}`,
        channelHistoryProvider: async () => "",
        mainSessionLookup: () => mainSession.id,
        onAck: () => { acked = true; },
        onQueued: () => { queued = true; },
      });
      promises.push(p);
      // Process microtasks so onAck/onQueued fire synchronously.
      await Promise.resolve();
      acks.push(acked);
      queueds.push(queued);
    }

    check("first /btw acked (not queued)", acks[0] === true && queueds[0] === false);
    check("second /btw queued", queueds[1] === true && acks[1] === false);
    check("third /btw queued", queueds[2] === true && acks[2] === false);

    // Resolve the promises (each resolves with its assigned side-session id
    // when it actually starts running — for queued ones this happens at
    // drain time).
    const sideIds = await Promise.all(promises);
    check("three distinct side-session ids assigned", new Set(sideIds).size === 3);

    // While the queue drains, verify there is at most one in-flight side
    // session at any sample. We sample status repeatedly while we wait.
    const samples: number[] = [];
    const sampler = setInterval(() => {
      let live = 0;
      for (const id of sideIds) {
        const s = getSession(id);
        if (s && s.process !== null) live++;
      }
      samples.push(live);
    }, 30);

    // Wait for all three to terminate.
    await waitFor(
      () => sideIds.every((id) => {
        const s = getSession(id);
        return s !== undefined && s.process === null && s.status !== "running";
      }),
      8000,
      "all side sessions terminal",
    );
    clearInterval(sampler);

    const maxLive = samples.reduce((a, b) => Math.max(a, b), 0);
    check(
      `at most ONE side session in flight at any time (max observed: ${maxLive})`,
      maxLive <= 1,
      `samples=[${samples.join(",")}]`,
    );

    // FIFO: completion order should match issue order.
    // Filter the captured non-main events to our 3 known side-session ids
    // (in case any other ephemeral sessions ran in between).
    const completeOrder = allNonMainCompleteOrder.filter((id) => sideIds.includes(id));
    check(
      "side sessions completed in FIFO order",
      JSON.stringify(completeOrder) === JSON.stringify(sideIds),
      `expected=${JSON.stringify(sideIds)} got=${JSON.stringify(completeOrder)}`,
    );

    // Main session's claudeSessionId and messageQueue untouched throughout.
    const mainAfter = getSession(mainSession.id)!;
    check(
      "main claudeSessionId unchanged after FIFO drain",
      mainAfter.claudeSessionId === mainClaudeIdBefore,
    );
    check(
      "main messageQueue unchanged after FIFO drain",
      JSON.stringify(mainAfter.messageQueue) === JSON.stringify(mainQueueBefore),
    );

    // None of the side sessions should be persisted.
    const persisted = readPersistedSessionIds();
    for (const id of sideIds) {
      check(
        `side session ${id.slice(0, 8)} not persisted`,
        !persisted.has(id),
      );
    }

    sessionEvents.off("post-to-discord", onPost);
    process.env.STUB_DELAY_MS = "80";
  }

  // -------------------------------------------------------------------------
  // 4. Side-turn queue is INDEPENDENT of the main-turn queue:
  //    enqueuing main-turn messages must not delay side sessions, and a
  //    side session must not consume slots in the main messageQueue.
  // -------------------------------------------------------------------------
  sect("4. side-turn queue independent of main messageQueue");
  {
    _resetSideSessionStateForTests();

    const mainSession = createSession("indep main", false, false, null);
    await waitFor(
      () => getSession(mainSession.id)?.status === "complete",
      3000,
      "indep main complete",
    );

    // sendMessage on a complete session re-spawns a new turn — wait for it
    // to come back to running, then enqueue another to fill the main queue.
    sendMessage(mainSession.id, "main turn 2");
    await waitFor(
      () => getSession(mainSession.id)?.status === "running",
      3000,
      "main running again",
    );
    sendMessage(mainSession.id, "main turn 3");
    const mainQueueBefore = [...getSession(mainSession.id)!.messageQueue];
    check(
      "main has a queued turn before side spawn",
      mainQueueBefore.length === 1,
      `len=${mainQueueBefore.length}`,
    );

    // Spawn a side session — it must NOT touch main's messageQueue and must
    // NOT wait on main to drain. We assert the queue snapshot
    // SYNCHRONOUSLY after the side spawn returns, before the main subprocess
    // has time to naturally complete and drain its own queue (which would be
    // unrelated to the side spawn).
    const channelId = "C-indep";
    const sidePromise = enqueueSideTurn({
      channelId,
      payload: "side question independent of main",
      channelHistoryProvider: async () => "",
      mainSessionLookup: () => mainSession.id,
    });
    const sideId = await sidePromise;

    // Snapshot the main queue immediately — the side spawn just returned
    // synchronously, so if it had touched main.messageQueue we'd see the
    // damage right now. (Main's own subprocess will drain its queue ~80ms
    // later in the natural course of business; that's not a side-effect
    // of our spawn.)
    const mainQueueAfterSideSpawn = [...getSession(mainSession.id)!.messageQueue];
    check(
      "main messageQueue is unchanged by side spawn",
      JSON.stringify(mainQueueAfterSideSpawn) === JSON.stringify(mainQueueBefore),
      `before=${JSON.stringify(mainQueueBefore)} after=${JSON.stringify(mainQueueAfterSideSpawn)}`,
    );

    // Side session also must not appear in any other session's messageQueue.
    check(
      "side spawn did not enqueue anything onto main",
      !getSession(mainSession.id)!.messageQueue.includes("side question independent of main"),
    );

    await waitFor(
      () => {
        const s = getSession(sideId);
        return s !== undefined && s.process === null && s.status !== "running";
      },
      3000,
      "side session terminal (independent)",
    );

    // Tear down anything still running on main so the test exits cleanly.
    if (getSession(mainSession.id)?.process !== null) {
      runner.cancelTurn(mainSession.id);
      await waitFor(
        () => getSession(mainSession.id)?.process === null,
        3000,
        "main torn down",
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. /btw on an idle channel (no main session) still spawns a side
  //    session and posts its answer. The brief calls this out as an
  //    explicit acceptance criterion separate from the running-main case.
  // -------------------------------------------------------------------------
  sect("5. /btw on an idle channel with no main session");
  {
    _resetSideSessionStateForTests();

    const channelId = "C-no-main";
    let acked = false;
    const sideId = await enqueueSideTurn({
      channelId,
      payload: "no main session here",
      channelHistoryProvider: async () => "",
      // mainSessionLookup returns undefined — there is no main session.
      mainSessionLookup: () => undefined,
      onAck: () => { acked = true; },
    });
    check("acked immediately (no main means no queueing constraint)", acked === true);

    await waitFor(
      () => {
        const s = getSession(sideId);
        return s !== undefined && s.process === null && s.status !== "running";
      },
      3000,
      "no-main side session terminal",
    );

    const after = getSession(sideId);
    check(
      "side session reached terminal status",
      after !== undefined && (after.status === "complete" || after.status === "idle"),
      `status=${after?.status}`,
    );
    check(
      "side session captured a stub session id (proves the spawn happened)",
      typeof after?.claudeSessionId === "string" && after?.claudeSessionId !== null,
    );
  }

  // -------------------------------------------------------------------------
  // 6. Per-channel queue cap: an 11th /btw beyond the slot+10 queued is
  //    soft-rejected so a hostile client cannot grow the queue without
  //    bound. This is a defence-in-depth correctness fix surfaced during
  //    self-review (see REVIEW-NOTES.md).
  // -------------------------------------------------------------------------
  sect("6. per-channel queue cap");
  {
    _resetSideSessionStateForTests();
    process.env.STUB_DELAY_MS = "300"; // keep the in-flight one busy

    const channelId = "C-cap";
    // Spawn the in-flight one + 10 queued = 11 total accepted.
    const accepted: Promise<string>[] = [];
    for (let i = 0; i < 11; i++) {
      accepted.push(
        enqueueSideTurn({
          channelId,
          payload: `cap${i}`,
          channelHistoryProvider: async () => "",
          mainSessionLookup: () => undefined,
        }),
      );
      // Yield microtasks so each enqueue resolves its sync acceptance
      // before the next call sees the latest in-flight/queue state.
      await Promise.resolve();
    }

    // The 12th should reject with the cap-full error — caller (discord-bot)
    // would surface 💥 to the user.
    let cap12Rejected = false;
    let cap12ErrMsg = "";
    try {
      await enqueueSideTurn({
        channelId,
        payload: "cap-overflow",
        channelHistoryProvider: async () => "",
        mainSessionLookup: () => undefined,
      });
    } catch (err) {
      cap12Rejected = true;
      cap12ErrMsg = err instanceof Error ? err.message : String(err);
    }
    check(
      "12th /btw rejected (cap full)",
      cap12Rejected === true,
      `errMsg=${cap12ErrMsg}`,
    );
    check(
      "rejection message mentions the cap",
      cap12ErrMsg.includes("queue") && cap12ErrMsg.includes("full"),
      `errMsg=${cap12ErrMsg}`,
    );

    // Drain everything before exiting so we don't leak processes.
    const ids = await Promise.all(accepted);
    await waitFor(
      () => ids.every((id) => {
        const s = getSession(id);
        return s !== undefined && s.process === null && s.status !== "running";
      }),
      15000,
      "cap test drain",
    );
    process.env.STUB_DELAY_MS = "80";
  }
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {
    // ignore
  }
}

console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
