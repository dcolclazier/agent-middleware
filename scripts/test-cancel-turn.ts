// Unit tests for cancelTurn() — distinct from killSession.
//
// Post-conditions cancelTurn must guarantee on a running session:
//   1. session.claudeSessionId is preserved (next message resumes the same
//      Claude conversation via --resume).
//   2. session.messageQueue is empty (anything queued during the cancelled
//      turn is dropped).
//   3. session.status === "idle" (NOT "error" — that's killSession's
//      destructive contract).
//   4. session.process is null (subprocess torn down).
//   5. NO `post-to-discord` event is emitted for the cancelled turn (we
//      neither flush partial output nor an error message).
//   6. A subsequent sendMessage() resumes the same Claude session via the
//      runner's normal --resume path.
//
// We don't have a real `claude` binary in CI, so the runner is configured
// (via CLAUDE_BIN env) to spawn `node` running a tiny "hang forever" script.
// That gives us a real ChildProcess we can SIGTERM and observe close events
// from, without depending on Anthropic's CLI.
//
// Run: npx tsx scripts/test-cancel-turn.ts

import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// --- Test harness setup ---
//
// We must set CLAUDE_BIN BEFORE importing claude-runner, because the runner
// reads it at module init. Same for CLAUDE_CWD (must be a real directory).

const tmpDir = mkdtempSync(join(tmpdir(), "cancel-turn-"));
const hangScript = join(tmpDir, "hang.js");
// Tiny hang-forever script. Emits a fake Claude init line so the runner
// captures a claudeSessionId, then sits there. We use the real Claude
// stream-json shape: {"type":"system","subtype":"init","session_id":"..."}.
writeFileSync(
  hangScript,
  `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"FAKE-SESSION-ID-12345"}) + "\\n");\nsetInterval(() => {}, 60000);\n`,
);

// Point the runner at `node` running our hang script. CLAUDE_ARGS will be
// appended after the script path and ignored by node.
process.env.CLAUDE_BIN = "node";
process.env.CLAUDE_BIN_PREFIX_ARG = hangScript;
process.env.CLAUDE_CWD = tmpDir;

// Isolate the runner's persistence — without this override, createSession()
// → saveSessions() writes to the repo-local sessions.json and pollutes
// local dev state with FAKE-SESSION-ID fixtures from these test runs.
process.env.CLAUDE_SESSIONS_FILE = join(tmpDir, "sessions.json");

const runner = await import("../src/claude-runner.js");
const { createSession, sendMessage, getSession, cancelTurn, sessionEvents } = runner;

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

// Wait until the predicate returns true, polling every 25ms up to timeout.
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

try {
  // -------------------------------------------------------------------------
  // 1. cancelTurn on a running session preserves claudeSessionId, drops
  //    messageQueue, sets status to idle, tears down the process.
  // -------------------------------------------------------------------------
  sect("1. cancelTurn post-conditions on a running session");
  {
    const session = createSession("hello", false, false, null);
    const sid = session.id;

    // Capture every post-to-discord event for this session.
    const postEvents: Array<{ sessionId: string; text: string }> = [];
    const onPost = (ev: { sessionId: string; text: string }) => {
      if (ev.sessionId === sid) postEvents.push(ev);
    };
    sessionEvents.on("post-to-discord", onPost);

    // Wait for the fake init line so claudeSessionId is captured.
    const captured = await waitFor(
      () => getSession(sid)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "claudeSessionId captured",
    );
    check("claudeSessionId captured before cancel", captured);

    // Queue a message during the in-flight turn (status is "running" because
    // the hang script never closes).
    const beforeStatus = getSession(sid)?.status;
    check(
      "session is running before cancel",
      beforeStatus === "running",
      `got status=${beforeStatus}`,
    );
    const queueRes = sendMessage(sid, "second turn please");
    check(
      "second message was queued (turn is in flight)",
      queueRes.queued === true,
      `got ${JSON.stringify(queueRes)}`,
    );
    const before = getSession(sid)!;
    check("messageQueue has the queued message", before.messageQueue.length === 1);

    // CANCEL.
    const ok = cancelTurn(sid);
    check("cancelTurn returns true on a running session", ok === true);

    // The subprocess close handler runs asynchronously. Give it a moment.
    await waitFor(
      () => getSession(sid)?.process === null,
      2000,
      "process torn down",
    );

    const after = getSession(sid)!;
    check("process is null", after.process === null);
    check(
      "claudeSessionId preserved",
      after.claudeSessionId === "FAKE-SESSION-ID-12345",
      `got ${after.claudeSessionId}`,
    );
    check(
      "status is idle (NOT error)",
      after.status === "idle",
      `got status=${after.status}`,
    );
    check(
      "messageQueue drained",
      after.messageQueue.length === 0,
      `length=${after.messageQueue.length}`,
    );
    check(
      "no post-to-discord event for the cancelled turn",
      postEvents.length === 0,
      `got ${postEvents.length} event(s): ${JSON.stringify(postEvents)}`,
    );
    check(
      "session.error is null (cancel is not an error)",
      after.error === null,
      `got ${after.error}`,
    );

    sessionEvents.off("post-to-discord", onPost);
  }

  // -------------------------------------------------------------------------
  // 2. cancelTurn on an idle / no-such session returns false (no-op).
  // -------------------------------------------------------------------------
  sect("2. cancelTurn no-op cases");
  {
    check(
      "cancelTurn on unknown id returns false",
      cancelTurn("does-not-exist") === false,
    );

    // Create a session and immediately cancel it once — it goes to idle.
    // A second cancel on an already-idle session should be a no-op (false).
    const session = createSession("ping", false, false, null);
    await waitFor(
      () => getSession(session.id)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "init captured",
    );
    cancelTurn(session.id);
    await waitFor(
      () => getSession(session.id)?.process === null,
      2000,
      "process torn down",
    );
    const second = cancelTurn(session.id);
    check(
      "second cancelTurn on idle session returns false (nothing to cancel)",
      second === false,
    );
  }

  // -------------------------------------------------------------------------
  // 3. After cancel, sendMessage resumes the same Claude session id.
  //    We can't actually resume a fake binary's session, but we can verify
  //    the resume path is taken by inspecting that:
  //      - session.process becomes non-null (a new spawn happened)
  //      - session.status flips back to "running"
  //      - the runner used --resume against the preserved claudeSessionId
  //
  //    For the third assertion we'd need to capture argv; the runner doesn't
  //    expose that. We assert the first two and trust that the resume code
  //    path uses --resume because session.claudeSessionId is non-null
  //    (this is enforced by resumeWithPrompt in claude-runner.ts).
  // -------------------------------------------------------------------------
  sect("3. sendMessage after cancel resumes the same Claude session");
  {
    const session = createSession("first turn", false, false, null);
    const sid = session.id;
    await waitFor(
      () => getSession(sid)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "init captured",
    );
    cancelTurn(sid);
    await waitFor(
      () => getSession(sid)?.process === null,
      2000,
      "torn down",
    );

    const before = getSession(sid)!;
    check("status is idle pre-resume", before.status === "idle");
    check(
      "claudeSessionId still pinned for the resume",
      before.claudeSessionId === "FAKE-SESSION-ID-12345",
    );

    // Resume.
    const r = sendMessage(sid, "next turn");
    check(
      "sendMessage on idle session is NOT queued (delivered immediately)",
      r.queued === false,
      `got ${JSON.stringify(r)}`,
    );
    const resumed = getSession(sid)!;
    check("process is non-null after resume", resumed.process !== null);
    check("status is running after resume", resumed.status === "running");
    check(
      "claudeSessionId still preserved through the resume",
      resumed.claudeSessionId === "FAKE-SESSION-ID-12345",
    );

    // Tear down so the test exits cleanly.
    cancelTurn(sid);
    await waitFor(() => getSession(sid)?.process === null, 2000, "final teardown");
  }

  // -------------------------------------------------------------------------
  // 4. Post-cancel race: a message enqueued in the SIGTERM→close window
  //    must NOT be silently dropped. cancelTurn() empties the queue
  //    synchronously and sends SIGTERM; the close handler runs async,
  //    so a sendMessage() between those two points lands in messageQueue
  //    while status is still "running". The cancellation short-circuit
  //    used to clear the queue unconditionally — now it must shift any
  //    post-cancel entry into the normal resume path.
  // -------------------------------------------------------------------------
  sect("4. post-cancel queue drain (SIGTERM→close window)");
  {
    const session = createSession("first turn", false, false, null);
    const sid = session.id;
    await waitFor(
      () => getSession(sid)?.claudeSessionId === "FAKE-SESSION-ID-12345",
      2000,
      "init captured",
    );

    // Snapshot the pre-cancel process reference so we can detect when
    // a NEW spawn replaces it (the resume of the post-cancel follow-up).
    const preCancelProc = getSession(sid)?.process;
    check("pre-cancel process is non-null", preCancelProc !== null && preCancelProc !== undefined);

    // Cancel synchronously, then immediately queue a follow-up — close
    // handler is async so this races into the SIGTERM→close window by
    // construction (JS is single-threaded; node IPC events fire on a
    // later tick).
    cancelTurn(sid);
    const r = sendMessage(sid, "post-cancel follow-up");
    check(
      "follow-up was queued (status was still 'running' pre-close)",
      r.queued === true,
      `got ${JSON.stringify(r)}`,
    );

    // Wait for the close handler to fire AND the post-cancel resume to
    // re-spawn the process. The terminal state we want: a NEW process
    // (different reference from preCancelProc) is running.
    await waitFor(
      () => {
        const s = getSession(sid);
        return s?.process !== null && s?.process !== preCancelProc && s?.status === "running";
      },
      3000,
      "post-cancel resume re-spawned",
    );

    const after = getSession(sid)!;
    check("post-cancel resume produced a NEW process (not the cancelled one)", after.process !== preCancelProc);
    check("status is 'running' on the resumed turn", after.status === "running");
    check(
      "claudeSessionId still preserved through the post-cancel resume",
      after.claudeSessionId === "FAKE-SESSION-ID-12345",
    );
    check("messageQueue drained (the follow-up was shifted out)", after.messageQueue.length === 0);

    // Tear down.
    cancelTurn(sid);
    await waitFor(() => getSession(sid)?.process === null, 2000, "final teardown");
  }
} finally {
  // Best-effort cleanup of the temp dir.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
