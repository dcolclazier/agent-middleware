import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// --- Types ---

export interface Session {
  id: string;
  process: ChildProcess | null;
  claudeSessionId: string | null;
  status: "running" | "idle" | "complete" | "error";
  outputBuffer: StreamEvent[];
  lastAssistantText: string;
  messageQueue: string[];
  createdAt: Date;
  goal: string;
  resultText: string | null;
  error: string | null;
  autoResume: boolean;
  webhook: boolean;
  callbackSessionKey: string | null;  // NemoClaw's session key for webhook routing
  /**
   * When true, listeners (e.g. discord-bot.ts) must NOT post this session's
   * final text to Discord. Used by createSessionAndAwait so harness-delegated
   * calls return their answer only to the Promise caller.
   */
  suppressDiscordPost?: boolean;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  result?: string;
  is_error?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// --- State ---

const sessions = new Map<string, Session>();

// SSE clients subscribe to session events
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(50);

// --- Persistence ---

const SESSIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "sessions.json");

interface PersistedSession {
  id: string;
  claudeSessionId: string | null;
  status: "running" | "idle" | "complete" | "error";
  goal: string;
  lastAssistantText: string;
  createdAt: string;
  autoResume: boolean;
  error: string | null;
  callbackSessionKey: string | null;
}

export function saveSessions() {
  const data: PersistedSession[] = Array.from(sessions.values()).map((s) => ({
    id: s.id,
    claudeSessionId: s.claudeSessionId,
    status: s.process ? "running" as const : s.status,  // if process alive, mark running; otherwise keep status
    goal: s.goal,
    lastAssistantText: s.lastAssistantText,
    createdAt: s.createdAt.toISOString(),
    autoResume: s.autoResume,
    error: s.error,
    callbackSessionKey: s.callbackSessionKey,
  }));
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save sessions: ${err}`);
  }
}

export function loadSessions() {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const data: PersistedSession[] = JSON.parse(raw);
    for (const d of data) {
      // Sessions that were "running" when we saved are now idle (process died with restart)
      const status = d.status === "running" ? "idle" as const : d.status;
      const session: Session = {
        id: d.id,
        process: null,
        claudeSessionId: d.claudeSessionId,
        status,
        outputBuffer: [],
        lastAssistantText: d.lastAssistantText,
        messageQueue: [],
        createdAt: new Date(d.createdAt),
        goal: d.goal,
        resultText: null,
        error: d.error,
        autoResume: d.autoResume,
        webhook: false,
        callbackSessionKey: d.callbackSessionKey || null,
      };
      sessions.set(d.id, session);
    }
    console.log(`Restored ${data.length} sessions from disk`);
  } catch {
    // No file or parse error — start fresh
  }
}

// --- Config ---

const CWD = process.env.CLAUDE_CWD || "/mnt/c/dev/dcc";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const SESSION_TIMEOUT = 3_600_000; // 1 hour

const CLAUDE_ARGS = [
  "--output-format", "stream-json",
  "--verbose",
  "--model", MODEL,
  "--allowedTools", "Edit,Write,Bash,Read,Glob,Grep,Agent",
  "--permission-mode", "bypassPermissions",
];

const SPAWN_OPTS: import("child_process").SpawnOptions = {
  cwd: CWD,
  env: { ...process.env },
  timeout: SESSION_TIMEOUT,
  stdio: ["ignore", "pipe", "pipe"],  // no stdin — prevents "no stdin data" warning
};

// --- Webhook ---

function notifyNemoClaw(session: Session, message: string) {
  // Emit event for Discord bot to pick up and post to the channel
  sessionEvents.emit("post-to-discord", {
    sessionId: session.id,
    text: message,
  });
}

// --- Helpers ---

function parseStreamLines(session: Session, raw: string): string {
  // Returns leftover incomplete line
  const lines = raw.split("\n");
  const leftover = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    session.outputBuffer.push(event);

    // Capture session ID from init event
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      session.claudeSessionId = event.session_id;
      saveSessions();
    }

    // Capture assistant text for progress reporting
    if (event.type === "assistant" && event.message?.content) {
      const texts = event.message.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) {
        session.lastAssistantText = texts.join("\n");
      }
    }

    // Capture final result
    if (event.type === "result") {
      if (event.result) {
        session.resultText = event.result;
        session.lastAssistantText = event.result;
      }
      if (event.is_error) {
        session.error = event.result || "Unknown error";
      }
    }

    // Emit for SSE subscribers
    sessionEvents.emit(`event:${session.id}`, event);
  }

  return leftover;
}

function attachProcessHandlers(session: Session, proc: ChildProcess) {
  let buffer = "";

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    buffer = parseStreamLines(session, buffer);
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      sessionEvents.emit(`event:${session.id}`, {
        type: "stderr",
        text,
      });
    }
  });

  proc.on("close", (code) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      parseStreamLines(session, buffer + "\n");
    }

    session.process = null;

    if (code !== 0 && code !== null) {
      session.status = "error";
      session.error = session.error || `Process exited with code ${code}`;
      saveSessions();
      notifyNemoClaw(session, `Error: ${session.error}`);
      sessionEvents.emit(`status:${session.id}`, session.status);
      sessionEvents.emit("status", { sessionId: session.id, status: session.status });
      return;
    }

    // Always notify NemoClaw of this iteration's response BEFORE processing the queue
    // (so follow-up messages don't suppress the previous response)
    if (session.lastAssistantText) {
      notifyNemoClaw(session, session.lastAssistantText);
    }

    // Check message queue — deliver queued messages first
    if (session.messageQueue.length > 0) {
      const nextMsg = session.messageQueue.shift()!;
      resumeWithPrompt(session, nextMsg);
      return;
    }

    // Check if Claude indicated completion
    const text = session.lastAssistantText.toLowerCase();
    const doneSignals = [
      "all iterations done",
      "all iterations complete",
      "target reached",
      "training complete",
      "task complete",
    ];
    const isDone = doneSignals.some((s) => text.includes(s));

    if (isDone) {
      session.status = "complete";
      saveSessions();
    } else if (session.autoResume) {
      session.status = "idle";
      saveSessions();
      resumeWithPrompt(session, "Continue to the next iteration. Report your progress clearly.");
    } else {
      session.status = "complete";
      saveSessions();
    }

    sessionEvents.emit(`status:${session.id}`, session.status);
    sessionEvents.emit("status", { sessionId: session.id, status: session.status });
  });
}

function resumeWithPrompt(session: Session, prompt: string) {
  const args = session.claudeSessionId
    ? ["-p", prompt, "--resume", session.claudeSessionId, ...CLAUDE_ARGS]
    : ["-p", prompt, ...CLAUDE_ARGS];

  const proc = spawn("claude", args, SPAWN_OPTS);

  session.process = proc;
  session.status = "running";
  attachProcessHandlers(session, proc);
  sessionEvents.emit(`status:${session.id}`, session.status);
  sessionEvents.emit("status", { sessionId: session.id, status: session.status });
}

// --- Public API ---

export function createSession(
  prompt: string,
  autoResume = false,
  webhook = false,
  callbackSessionKey: string | null = null,
  opts: { suppressDiscordPost?: boolean } = {},
): Session {
  const id = crypto.randomUUID();

  const proc = spawn("claude", ["-p", prompt, ...CLAUDE_ARGS], SPAWN_OPTS);

  const session: Session = {
    id,
    process: proc,
    claudeSessionId: null,
    status: "running",
    outputBuffer: [],
    lastAssistantText: "",
    messageQueue: [],
    createdAt: new Date(),
    goal: prompt,
    resultText: null,
    error: null,
    autoResume,
    webhook,
    callbackSessionKey,
    suppressDiscordPost: opts.suppressDiscordPost === true,
  };

  attachProcessHandlers(session, proc);
  sessions.set(id, session);
  saveSessions();
  sessionEvents.emit("status", { sessionId: id, status: "running" });
  return session;
}

/**
 * Create a one-shot Claude session and return a Promise that resolves with
 * the final assistant text when status flips to "complete", or rejects on
 * "error" / timeout. The session's suppressDiscordPost flag is set so the
 * answer does NOT get double-posted to Discord — it flows only to the
 * caller. Used by the Qwen harness's `ask_claudecode` tool.
 *
 * NOTE on `resumeSessionId`: the current claude-runner.ts doesn't have a
 * direct "resume an existing Claude session id on creation" path — it only
 * resumes on sendMessage. We accept the option to honor the caller's API
 * contract, but if it's supplied we fall back to starting a fresh session
 * with the prompt (the claude CLI will start a new session id). A real
 * resume path can be wired later when the harness needs it.
 */
export function createSessionAndAwait(
  prompt: string,
  opts: {
    suppressDiscordPost?: boolean;
    timeoutMs?: number;
    resumeSessionId?: string | null;
  } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const suppressDiscordPost = opts.suppressDiscordPost !== false; // default true
  void opts.resumeSessionId; // accepted for API compat; not yet wired — see note above

  const session = createSession(prompt, false, false, null, { suppressDiscordPost });
  const sessionId = session.id;
  // Listen on the per-session event name `status:<id>` so we never bump the
  // global "status" listener count (which would otherwise trigger Node's
  // MaxListenersExceededWarning under bursts of ask_claudecode delegations).
  const statusEvent = `status:${sessionId}`;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      sessionEvents.off(statusEvent, onStatus);
      clearTimeout(timer);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onStatus = (status: string) => {
      if (status === "complete") {
        const current = sessions.get(sessionId);
        const text = current?.resultText || current?.lastAssistantText || "";
        finish(() => resolve(text));
      } else if (status === "error") {
        const current = sessions.get(sessionId);
        const errMsg = current?.error || "Claude session ended with error";
        finish(() => reject(new Error(errMsg)));
      }
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          killSession(sessionId);
        } catch {
          // ignore
        }
        reject(new Error(`createSessionAndAwait timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    sessionEvents.on(statusEvent, onStatus);
  });
}

export function sendMessage(
  id: string,
  message: string
): { queued: boolean; status: string } {
  const session = sessions.get(id);
  if (!session) throw new Error("Session not found");

  if (session.status === "complete" || session.status === "error") {
    // Session is done — resume with the new message (starts a new turn)
    resumeWithPrompt(session, message);
    return { queued: false, status: session.status };
  }

  if (session.status === "running") {
    session.messageQueue.push(message);
    return { queued: true, status: "running" };
  }

  // idle — deliver immediately
  resumeWithPrompt(session, message);
  return { queued: false, status: session.status };
}

export function getProgress(id: string) {
  const session = sessions.get(id);
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    lastOutput: session.lastAssistantText,
    queuedMessages: session.messageQueue.length,
    totalEvents: session.outputBuffer.length,
    error: session.error,
    claudeSessionId: session.claudeSessionId,
  };
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    status: s.status,
    createdAt: s.createdAt,
    goal: s.goal.slice(0, 300),
    queuedMessages: s.messageQueue.length,
    lastOutput: s.lastAssistantText.slice(0, 500),
  }));
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.process) {
    session.process.kill("SIGTERM");
    session.status = "error";
    session.error = "Killed by user";
    session.process = null;
  }
  saveSessions();
  return true;
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.process) {
    session.process.kill("SIGTERM");
  }
  sessions.delete(id);
  saveSessions();
  return true;
}

export function getSessionCount() {
  let running = 0;
  let idle = 0;
  let complete = 0;
  let error = 0;
  for (const s of sessions.values()) {
    if (s.status === "running") running++;
    else if (s.status === "idle") idle++;
    else if (s.status === "complete") complete++;
    else if (s.status === "error") error++;
  }
  return { total: sessions.size, running, idle, complete, error };
}
