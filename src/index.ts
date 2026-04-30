import express from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  createSession,
  sendMessage,
  getProgress,
  getSession,
  listSessions,
  killSession,
  deleteSession,
  getSessionCount,
  sessionEvents,
  loadSessions,
} from "./claude-runner.js";
import { authMiddleware, canonAuth } from "./auth.js";
import { startDiscordBot, getChannelSessions, getChannelRecent, getChannelForSession } from "./discord-bot.js";
import { startQwenBot, getQwenBotStatus, getShowThinking, setShowThinking } from "./qwen-bot.js";
import {
  commitCanon,
  pushCanon,
  getCanonStatus,
  resetCanon,
  CanonError,
  isValidAgent,
  type Agent,
} from "./canon-commit.js";
import { runQwenTurn, getQwenSession } from "./qwen-harness.js";

// Load .env manually (no dotenv dependency)
import { readFileSync } from "fs";
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env is optional
}

// --- Process-level crash safety ---
//
// A single unhandled rejection in any event listener, SSE stream, or bot
// handler would otherwise kill the entire process with no log and no state
// flush. We install handlers that log the full stack, attempt a best-effort
// save of Claude sessions to disk, and exit non-zero so systemd/supervisor
// can restart. We deliberately DO NOT try to recover in-process — running
// degraded is worse than failing fast.
import { saveSessions } from "./claude-runner.js";

let shuttingDown = false;
// Set true by the self-restart endpoint before the helper's kill lands.
// The SIGTERM handler consults this to distinguish "planned restart"
// (log cleanly, no [FATAL] / stack trace) from "something went wrong
// and the supervisor is killing us" (still log loudly for forensics).
let expectingRestart = false;
function panicFlushAndExit(
  label: string,
  err: unknown,
  code: number,
  opts?: { clean?: boolean },
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const clean = opts?.clean === true;
  if (clean) {
    console.log(`[shutdown] ${label}: flushing sessions and exiting cleanly`);
  } else {
    const msg =
      err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    console.error(`[FATAL ${label}] ${msg}`);
  }
  try {
    saveSessions();
  } catch (e) {
    const prefix = clean ? `[shutdown ${label}]` : `[FATAL ${label}]`;
    console.error(`${prefix} saveSessions also failed: ${e}`);
  }
  // Give stderr a brief moment to flush before we exit.
  setTimeout(() => process.exit(code), 200);
}

process.on("unhandledRejection", (reason) => {
  panicFlushAndExit("unhandledRejection", reason, 1);
});
process.on("uncaughtException", (err) => {
  panicFlushAndExit("uncaughtException", err, 1);
});
process.on("SIGTERM", () => {
  // Planned restart path: the self-restart endpoint sets `expectingRestart`
  // before its helper sends SIGTERM. Log cleanly instead of [FATAL] noise.
  const clean = expectingRestart;
  console.log(
    clean ? "[shutdown] SIGTERM received (scheduled restart)" : "[shutdown] SIGTERM received",
  );
  panicFlushAndExit("SIGTERM", new Error("SIGTERM"), 0, { clean });
});
process.on("SIGINT", () => {
  console.log("[shutdown] SIGINT received");
  panicFlushAndExit("SIGINT", new Error("SIGINT"), 0);
});

// Restore persisted sessions before starting
loadSessions();

// Start both Discord bots in parallel (async — doesn't block server startup).
// A failing Qwen startup (e.g. missing token, bad credentials) must never
// block ClaudeCode, so we settle both independently.
Promise.allSettled([startDiscordBot(), startQwenBot()]).then((results) => {
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      const who = i === 0 ? "ClaudeCode" : "Qwen";
      console.error(`[${who}] bot startup rejected: ${r.reason}`);
    }
  }
});

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Middleware
app.use(express.json());

// Static files for monitoring SPA — unauthenticated (public dashboard)
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, "..", "public")));

// --- Route-level auth ---
//
// Session control + Discord channel introspection require authMiddleware
// (token-based). Canon + Qwen endpoints use the stricter `canonAuth` on
// their own routes. /api/health is public. Historically this process used
// a global `app.use(authMiddleware)` that was a no-op; that was effectively
// RCE on the Claude CLI from any LAN host. Now the middleware fails closed
// and is scoped to session-management path prefixes.
app.use("/api/sessions", authMiddleware);
app.use("/api/channels", authMiddleware);
app.use("/api/channel-sessions", authMiddleware);
app.use("/api/middleware", authMiddleware);

// --- Middleware self-restart state ---
//
// POST /api/middleware/restart schedules a detached bash helper that kills
// this process group after a delay and launches a new middleware from the
// correct working directory. Debounced module-level state prevents a burst
// of concurrent callers from stacking multiple restart helpers.
//
// Why a detached helper? Claude's CLI is spawned as a direct child of the
// middleware Node process. If Claude tries `kill <pgid>` from inside a
// Bash tool call, the kill takes Claude down too — the follow-up `npm start`
// never runs. The detached helper is reparented to init on spawn, so it
// survives the middleware kill and can run the relaunch cleanly.
let restartScheduled = false;
let restartScheduledAt: number | null = null;
let restartFirstReason: string | null = null;
let restartDelayMs = 0;

// --- Routes ---

// Health check
app.get("/api/health", (_req, res) => {
  const counts = getSessionCount();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: counts,
  });
});

// List all sessions
app.get("/api/sessions", (_req, res) => {
  res.json(listSessions());
});

// List channel → session mappings (Discord bot)
app.get("/api/channel-sessions", (_req, res) => {
  res.json(getChannelSessions());
});

// Fetch recent messages from a Discord channel (for Claude to catch up mid-session)
app.get("/api/channels/:channelId/recent", async (req, res) => {
  const limit = parseInt(req.query.limit as string || "30", 10);
  const messages = await getChannelRecent(req.params.channelId, Math.min(limit, 100));
  res.json({ messages });
});

// Convenience: fetch recent messages for a session's channel (Claude doesn't need to know channelId)
app.get("/api/sessions/:id/recent", async (req, res) => {
  const channelId = getChannelForSession(req.params.id);
  if (!channelId) {
    res.status(404).json({ error: "Session not associated with a Discord channel" });
    return;
  }
  const limit = parseInt(req.query.limit as string || "30", 10);
  const messages = await getChannelRecent(channelId, Math.min(limit, 100));
  res.json({ channelId, messages });
});

// --- Canon commit endpoints (authenticated) ---
//
// NemoClaw (from spark-45aa) posts generated canon content here. The middleware
// writes it to a staging area under SPARK/output/canon/nemoclaw/, commits, and
// pushes to a branch. Claude Code (via the Discord bot) fetches, scores, and
// promotes to training_data_truth via git mv if the content passes.

function handleCanonError(err: unknown, res: express.Response): void {
  if (err instanceof CanonError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Canon error: ${msg}`);
  res.status(500).json({ error: msg });
}

/**
 * Extract the agent identity for a canon request. Priority:
 *   1. X-Canon-Agent header
 *   2. body.agent field
 *   3. default "claude" (backward compat with NemoClaw's existing curl flow)
 * Returns null if the caller provided an explicit but invalid value
 * (so we can 400 instead of silently defaulting).
 */
function resolveCanonAgent(req: express.Request): Agent | null {
  const headerVal = req.header("X-Canon-Agent");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodyVal = (req.body && typeof req.body === "object") ? (req.body as any).agent : undefined;
  const explicit = headerVal ?? bodyVal;
  if (explicit === undefined || explicit === null || explicit === "") {
    return "claude";
  }
  return isValidAgent(explicit) ? explicit : null;
}

app.post("/api/canon/commit", canonAuth, async (req, res) => {
  const agent = resolveCanonAgent(req);
  if (!agent) {
    res.status(400).json({ error: "Invalid agent. Must be one of: claude, qwen, nemoclaw" });
    return;
  }
  try {
    const result = await commitCanon({ ...req.body, agent });
    res.status(201).json(result);
  } catch (err) {
    handleCanonError(err, res);
  }
});

app.post("/api/canon/push", canonAuth, async (req, res) => {
  const agent = resolveCanonAgent(req);
  if (!agent) {
    res.status(400).json({ error: "Invalid agent. Must be one of: claude, qwen, nemoclaw" });
    return;
  }
  try {
    const result = await pushCanon(agent);
    res.json(result);
  } catch (err) {
    handleCanonError(err, res);
  }
});

app.get("/api/canon/status", canonAuth, async (req, res) => {
  const agent = resolveCanonAgent(req);
  if (!agent) {
    res.status(400).json({ error: "Invalid agent. Must be one of: claude, qwen, nemoclaw" });
    return;
  }
  try {
    const result = await getCanonStatus(agent);
    res.json(result);
  } catch (err) {
    handleCanonError(err, res);
  }
});

app.post("/api/canon/reset", canonAuth, async (req, res) => {
  const agent = resolveCanonAgent(req);
  if (!agent) {
    res.status(400).json({ error: "Invalid agent. Must be one of: claude, qwen, nemoclaw" });
    return;
  }
  try {
    const result = await resetCanon(agent);
    res.json(result);
  } catch (err) {
    handleCanonError(err, res);
  }
});

// Qwen Discord bot status (authenticated via the canon token so only LAN
// callers can poke it). The kill-switch itself remains a Discord-only
// affordance for now — toggle by @-mentioning the bot with "disable" /
// "enable" from the target channel.
app.get("/api/qwen/bot-status", canonAuth, (_req, res) => {
  res.json({ ...getQwenBotStatus(), showThinking: getShowThinking() });
});

// Toggle Qwen's <think> chain-of-thought display in Discord replies.
// GET = current state; POST {show: boolean} = update. Runtime-only;
// middleware restart resets to the QWEN_SHOW_THINKING env var default.
app.get("/api/qwen/thinking", canonAuth, (_req, res) => {
  res.json({ showThinking: getShowThinking() });
});
app.post("/api/qwen/thinking", canonAuth, (req, res) => {
  const body = (req.body ?? {}) as { show?: boolean };
  if (typeof body.show !== "boolean") {
    res.status(400).json({ error: "body.show must be boolean" });
    return;
  }
  setShowThinking(body.show);
  res.json({ showThinking: getShowThinking() });
});

// --- Middleware self-restart endpoint ---
//
// POST /api/middleware/restart
// Body: { reason?: string, delay_ms?: number }
//
// Schedules a detached bash helper to kill this process group and launch
// a fresh middleware after `delay_ms` (default 3000, clamped 1000-30000).
// Returns 202 immediately with the scheduled window so the caller's HTTP
// response flushes before the kill fires.
//
// Debounced: a second call while a restart is already pending returns 409
// with the remaining time.
//
// See NOTES.md → "Claude Middleware → Restarting from inside a session"
// for usage from Claude sessions.

const MIDDLEWARE_DIR = process.env.MIDDLEWARE_DIR || "/mnt/c/dev/agent-middleware";
const MIDDLEWARE_LOG_PATH = "/tmp/claude-middleware.log";

function scheduleRestartHelper(delayMs: number, parentPid: number): void {
  // Helper script: sleep the requested delay, resolve PGID from the passed
  // PID, kill the process group, wait for port cleanup, relaunch from the
  // correct cwd. All logs append to the canonical middleware log so
  // operators see the kill/restart sequence interleaved with the normal
  // startup messages.
  const script = `
set -u
PID="$MIDDLEWARE_PID"
DELAY_MS="$MIDDLEWARE_RESTART_DELAY_MS"
LOG_PATH="${MIDDLEWARE_LOG_PATH}"
MIDDLEWARE_DIR="${MIDDLEWARE_DIR}"

# Wait the caller's requested delay so the HTTP response and any in-flight
# Discord messages flush before the kill lands.
sleep "$(awk "BEGIN{print $DELAY_MS / 1000}")"

# Resolve PGID from the PID running at schedule time. If the middleware
# already died for some other reason, the kill is a no-op. Strip all
# whitespace (not just spaces) so trailing newlines don't corrupt the
# kill target on some ps implementations.
PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d '[:space:]')
if [ -n "$PGID" ]; then
  echo "[restart-helper] killing PGID $PGID (from PID $PID)" >> "$LOG_PATH" 2>&1
  kill -- "-$PGID" 2>/dev/null || true
fi

# Give the port time to free up. WSL is slow about releasing listeners.
sleep 3

# Start fresh. cd is mandatory — npm start looks for package.json in cwd.
cd "$MIDDLEWARE_DIR"
echo "[restart-helper] starting new middleware at $(date -u +%FT%TZ)" >> "$LOG_PATH" 2>&1
nohup npm start >> "$LOG_PATH" 2>&1
`;
  const child = spawn("bash", ["-c", script], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MIDDLEWARE_PID: String(parentPid),
      MIDDLEWARE_RESTART_DELAY_MS: String(delayMs),
    },
  });
  // Detach from the Node event loop entirely so the parent can exit
  // without waiting for the helper.
  child.unref();
}

// ---------------------------------------------------------------------------
// MemPalace memory endpoints — used by NemoClaw and any agent over HTTP.
// Proxies to the MemPalace API server on Spark #2.
// Gated by canonAuth (same LAN-only token as canon endpoints).
// ---------------------------------------------------------------------------
import {
  isEnabled as mpIsEnabled,
  mpSearch as mpSearchFn,
  mpAddDrawer as mpAddDrawerFn,
  mpListDrawers as mpListDrawersFn,
  mpDeleteDrawer as mpDeleteDrawerFn,
  mpKgAdd as mpKgAddFn,
  mpKgQuery as mpKgQueryFn,
  mpStatus as mpStatusFn,
} from "./mempalace-client.js";

app.get("/api/memory/status", canonAuth, async (_req, res) => {
  if (!mpIsEnabled()) {
    res.status(503).json({ error: "MEMPALACE_ENABLED is not set" });
    return;
  }
  const status = await mpStatusFn();
  res.json(status ?? { error: "unreachable" });
});

app.post("/api/memory/search", canonAuth, async (req, res) => {
  const { query, limit, wing, room } = req.body ?? {};
  const results = await mpSearchFn(query ?? "", { limit, wing, room });
  res.json({ results });
});

app.post("/api/memory/store", canonAuth, async (req, res) => {
  const { wing, room, content, source_file, added_by } = req.body ?? {};
  if (!wing || !room || !content) {
    res.status(400).json({ error: "wing, room, and content are required" });
    return;
  }
  const result = await mpAddDrawerFn(wing, room, content, { source_file, added_by });
  res.json(result);
});

app.post("/api/memory/list", canonAuth, async (req, res) => {
  const { wing, room, limit, offset } = req.body ?? {};
  const drawers = await mpListDrawersFn({ wing, room, limit, offset });
  res.json({ drawers });
});

app.delete("/api/memory/drawer/:id", canonAuth, async (req, res) => {
  const drawerId = Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id;
  const removed = await mpDeleteDrawerFn(drawerId);
  res.json({ removed, id: drawerId });
});

app.post("/api/memory/kg/add", canonAuth, async (req, res) => {
  const { subject, predicate, object, valid_from } = req.body ?? {};
  if (!subject || !predicate || !object) {
    res.status(400).json({ error: "subject, predicate, and object are required" });
    return;
  }
  const result = await mpKgAddFn(subject, predicate, object, valid_from);
  res.json(result);
});

app.post("/api/memory/kg/query", canonAuth, async (req, res) => {
  const { entity, as_of, direction } = req.body ?? {};
  if (!entity) {
    res.status(400).json({ error: "entity is required" });
    return;
  }
  const result = await mpKgQueryFn(entity, { as_of, direction });
  res.json(result);
});

app.post("/api/middleware/restart", (req, res) => {
  // --- Debounce ---
  if (restartScheduled && restartScheduledAt !== null) {
    const elapsed = Date.now() - restartScheduledAt;
    const remaining = Math.max(0, restartDelayMs - elapsed);
    res.status(409).json({
      status: "already_scheduled",
      scheduled_in_ms: remaining,
      first_scheduled_at: new Date(restartScheduledAt).toISOString(),
      first_reason: restartFirstReason,
    });
    return;
  }

  // --- Body validation ---
  const body = (req.body ?? {}) as { reason?: unknown; delay_ms?: unknown };
  let reason: string | null = null;
  if (typeof body.reason === "string") {
    reason = body.reason.slice(0, 200);
  } else if (body.reason !== undefined && body.reason !== null) {
    res.status(400).json({ error: "body.reason must be a string if provided" });
    return;
  }
  let delayMs = 3000;
  if (typeof body.delay_ms === "number" && Number.isFinite(body.delay_ms)) {
    delayMs = Math.max(1000, Math.min(30000, Math.floor(body.delay_ms)));
  } else if (body.delay_ms !== undefined && body.delay_ms !== null) {
    res.status(400).json({ error: "body.delay_ms must be a number if provided" });
    return;
  }

  // --- Resolve caller IP for the log line only (no IP gating) ---
  let clientIp = req.socket.remoteAddress || "unknown";
  if (clientIp.startsWith("::ffff:")) clientIp = clientIp.slice(7);
  if (clientIp === "::1") clientIp = "127.0.0.1";

  // --- Commit state + log + fire the helper ---
  restartScheduled = true;
  restartScheduledAt = Date.now();
  restartFirstReason = reason;
  restartDelayMs = delayMs;
  // Tell the SIGTERM handler that the incoming kill is a planned restart,
  // not a crash — so it logs cleanly instead of [FATAL] + stack trace.
  expectingRestart = true;

  console.log(
    `[restart] scheduled in ${delayMs}ms by ${clientIp} pid=${process.pid} reason=${reason ?? "(none)"}`,
  );

  try {
    scheduleRestartHelper(delayMs, process.pid);
  } catch (err) {
    // If the spawn itself fails (very rare — e.g. bash missing), roll back
    // the debounce state so a retry can actually retry.
    restartScheduled = false;
    restartScheduledAt = null;
    restartFirstReason = null;
    restartDelayMs = 0;
    expectingRestart = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[restart] helper spawn failed: ${msg}`);
    res.status(500).json({ error: `Failed to spawn restart helper: ${msg}` });
    return;
  }

  res.status(202).json({
    status: "scheduled",
    scheduled_in_ms: delayMs,
    current_pid: process.pid,
    reason,
  });
});

// --- Qwen harness smoke endpoint (Phase 1) ---
//
// POST /api/qwen/test
// Body: { channelId?: string, prompt: string }
// Exercises runQwenTurn() end-to-end: tool loop, session persistence, stop
// conditions, etc. Gated by the same canonAuth middleware so only the LAN
// allowlist with the canon token can drive it. No Discord side-effects.
app.post("/api/qwen/test", canonAuth, async (req, res) => {
  const body = (req.body ?? {}) as { channelId?: string; prompt?: string };
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required (string)" });
    return;
  }
  const channelId = body.channelId && typeof body.channelId === "string"
    ? body.channelId
    : "test-channel";

  try {
    const result = await runQwenTurn(channelId, prompt);
    const session = await getQwenSession(channelId);
    res.json({
      sessionId: result.sessionId,
      finalText: result.finalText,
      stopReason: result.stopReason,
      turns: result.turns,
      messageCount: session ? session.messages.length : 0,
      toolFailures: session ? session.toolFailures : {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`/api/qwen/test error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// Create new session
app.post("/api/sessions", (req, res) => {
  const { prompt, autoResume, webhook, callbackSessionKey } = req.body;
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const session = createSession(prompt, !!autoResume, !!webhook, callbackSessionKey || null);
  res.status(201).json({
    id: session.id,
    status: session.status,
    createdAt: session.createdAt,
  });
});

// Get session progress
app.get("/api/sessions/:id/progress", (req, res) => {
  const progress = getProgress(req.params.id);
  if (!progress) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(progress);
});

// Get session status (lightweight)
app.get("/api/sessions/:id/status", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({
    id: session.id,
    status: session.status,
    queuedMessages: session.messageQueue.length,
  });
});

// Send message to session
app.post("/api/sessions/:id/message", (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const result = sendMessage(req.params.id, message);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(404).json({ error: msg });
  }
});

// Kill session
app.post("/api/sessions/:id/kill", (req, res) => {
  const ok = killSession(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ status: "killed" });
});

// Delete session
app.delete("/api/sessions/:id", (req, res) => {
  const ok = deleteSession(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ status: "deleted" });
});

// SSE stream for live log output
app.get("/api/sessions/:id/stream", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send current state as initial burst
  res.write(
    `data: ${JSON.stringify({ type: "init", status: session.status, lastOutput: session.lastAssistantText, queuedMessages: session.messageQueue.length })}\n\n`
  );

  // Subscribe to new events
  const eventKey = `event:${req.params.id}`;
  const statusKey = `status:${req.params.id}`;

  const onEvent = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const onStatus = (status: string) => {
    res.write(
      `data: ${JSON.stringify({ type: "status_change", status })}\n\n`
    );
  };

  sessionEvents.on(eventKey, onEvent);
  sessionEvents.on(statusKey, onStatus);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sessionEvents.off(eventKey, onEvent);
    sessionEvents.off(statusKey, onStatus);
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Code Middleware running on http://0.0.0.0:${PORT}`);
  console.log(`Monitor: http://localhost:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/api/health`);
});
