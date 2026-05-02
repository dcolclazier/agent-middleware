// --- /btw side-session helper ---
//
// Implements the dispatch path for the `/btw` channel slash-command (issue
// #15). A side session is an ephemeral, single-turn `Session` that runs a
// quick aside in parallel to the channel's main turn — see CONTEXT.md →
// Side session and ADR-0005.
//
// Load-bearing rules from ADR-0005 and the agent brief on #15:
//
//  - Side session is created with a FRESH Claude session id. We MUST NOT
//    pass `--resume <main-claude-session-id>` because two `claude -p
//    --resume` subprocesses on the same id race on the on-disk session
//    state and silently corrupt the main session. The helper enforces this
//    by calling `createSession(prompt, …)` (no resume), which the runner
//    spawns with bare `-p prompt …` arguments.
//
//  - Side session is NOT persisted to `sessions.json`. The runner's
//    `saveSessions` skips sessions with `ephemeral: true`. The Session
//    record stays in the runner's in-memory `sessions` map for the rest of
//    the process lifetime (bounded by `/btw` traffic; cleared at the next
//    restart). A future slice can add an explicit map sweep on terminal
//    if `/btw` traffic grows enough that the retained outputBuffer arrays
//    show up in heap profiles.
//
//  - Side session NEVER overwrites the channel→Session mapping. This
//    module does not touch `BotInstance.setSessionForChannel`; only the
//    main-turn dispatch path does.
//
//  - At most ONE in-flight side session per channel. A second `/btw` while
//    one is still running goes onto a per-channel FIFO queue and drains in
//    order when the previous side session terminates. This queue is
//    INDEPENDENT of the main session's `messageQueue` — `/btw` traffic
//    never blocks the main turn and vice versa.
//
//  - The seeded prompt = recent channel history + main session's
//    `lastAssistantText` (when present) + the user's `/btw` payload. Each
//    piece is silently skipped when empty. The labelled scaffolding
//    (`# Recent channel history`, `# Main turn — last assistant text`) is
//    only emitted when its piece is non-empty so a payload-only call gives
//    Claude a clean prompt with no confusing empty headers.
//
// Test coverage: scripts/test-side-session-queue.ts.

import { createSession, getSession, sessionEvents, type Session } from "./claude-runner.js";

// --- Pure prompt seeding ---

export interface SeedSidePromptInput {
  /** Recent Discord channel history, already formatted for prompt insertion. */
  channelHistory: string;
  /**
   * The main session's `lastAssistantText` at the moment of /btw. May be
   * empty if there is no main session, or if the main turn has not yet
   * produced any assistant text.
   */
  mainLastAssistantText: string;
  /** The user's /btw payload — everything after the verb, trimmed. */
  payload: string;
}

/**
 * Compose the seeded prompt for a /btw side session.
 *
 * Pure function. Empty pieces are silently skipped along with their header
 * scaffolding so payload-only callers see a clean prompt.
 */
export function seedSidePrompt(input: SeedSidePromptInput): string {
  const parts: string[] = [];
  if (input.channelHistory.trim()) {
    parts.push(`# Recent channel history (for context)\n\n${input.channelHistory.trim()}`);
  }
  if (input.mainLastAssistantText.trim()) {
    parts.push(
      `# Main turn — last assistant text (read-only snapshot of what the main turn was just saying; you do NOT have access to its tool calls)\n\n${input.mainLastAssistantText.trim()}`,
    );
  }
  // The payload is always present. If we have any scaffolding above, label
  // the payload too so Claude knows where the question starts; otherwise
  // emit it bare to keep payload-only prompts clean.
  if (parts.length > 0) {
    parts.push(`# Side question (/btw)\n\n${input.payload}`);
  } else {
    parts.push(input.payload);
  }
  return parts.join("\n\n---\n\n");
}

// --- Per-channel side-turn FIFO queue ---
//
// Each channel may have ONE in-flight side session and a FIFO queue of
// pending side turns. The queue's job is to delay the spawn of subsequent
// /btw calls — once a queued turn fires, it goes through the same
// `enqueueSideTurn` path as a fresh call (so the prompt seeding re-fetches
// channel history at drain time, not at queue time).

interface PendingSideTurn {
  channelId: string;
  payload: string;
  channelHistoryProvider: () => Promise<string>;
  mainSessionLookup: () => string | undefined;
  resolve: (sessionId: string) => void;
  reject: (err: unknown) => void;
}

/** channelId → in-flight side-session id (set when running, cleared when terminal). */
const inFlightByChannel = new Map<string, string>();
/** channelId → FIFO of pending /btw calls waiting for the slot to free. */
const queueByChannel = new Map<string, PendingSideTurn[]>();

// --- Public helper ---

export interface EnqueueSideTurnInput {
  channelId: string;
  payload: string;
  /**
   * Lazy: produces the formatted channel history at spawn time. Lazy so a
   * queued /btw fetches FRESH history when its slot frees, not stale
   * history from when it was first issued.
   */
  channelHistoryProvider: () => Promise<string>;
  /**
   * Lazy: returns the channel's current main session id (or undefined if
   * there is no main session). The helper uses this to look up the main
   * session's `lastAssistantText`. Lazy because the channel mapping can
   * change between `/btw` enqueue and `/btw` drain (e.g. a `/end` runs in
   * between).
   */
  mainSessionLookup: () => string | undefined;
  /**
   * Optional: invoked synchronously when the /btw is accepted to run
   * IMMEDIATELY (no queueing). Discord-bot wires this to react 🤔.
   */
  onAck?: () => void;
  /**
   * Optional: invoked synchronously when the /btw is QUEUED behind another
   * side turn. Discord-bot wires this to react ⏳. Mutually exclusive with
   * onAck.
   */
  onQueued?: () => void;
}

/**
 * Maximum pending /btw entries per channel. Above this we soft-reject the
 * /btw — the discord-bot path will see the rejection and react 💥, telling
 * the user to wait. Defends against a misbehaving client spamming /btw
 * indefinitely (each queue entry retains closures over the discord-bot's
 * `self`, the message, and the trigger — unbounded growth is a memory
 * pressure vector). 10 is generous: at the 5 msg/sec Discord rate limit
 * a user has to spam for 2+ seconds before hitting the cap.
 */
const MAX_QUEUE_PER_CHANNEL = 10;

/** Sentinel value used in `inFlightByChannel` to reserve a slot synchronously
 * before the spawned session id is known (we can't put a real session id
 * there yet because spawn happens after an async history fetch). The
 * lifetime of this sentinel is at most one event-loop tick — `spawnAndTrack`
 * overwrites it with the real session id immediately after `createSession`. */
const SLOT_RESERVED_SENTINEL = "<reserved>";

/**
 * Accept a /btw call for a channel.
 *
 * If no side session is in flight for the channel, spawns immediately and
 * returns the new side-session id. If one is in flight, the call is queued
 * FIFO and the returned promise resolves with the side-session id at drain
 * time.
 *
 * This is the Discord-bot dispatch entry point — it owns all the side-turn
 * lifecycle bookkeeping (in-flight marker, queue, post-to-discord listener
 * for drain). The caller does not see any of that machinery.
 *
 * The returned Promise resolves with the spawned session id at SPAWN time
 * (not at completion) — that's the moment the discord-bot needs to bind a
 * trigger to the session for the existing reaction listeners.
 */
export function enqueueSideTurn(input: EnqueueSideTurnInput): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Synchronous slot reservation: we MUST set inFlightByChannel before
    // anything async runs, because spawnAndTrack awaits the channel-history
    // provider before it gets a session id to put here. Without this
    // reservation, two concurrent /btw calls in the same microtask tick
    // would both pass the "is anything in flight?" check, both spawn, and
    // we'd violate the at-most-one-side-session-per-channel AC.
    const inFlight = inFlightByChannel.get(input.channelId);
    if (inFlight !== undefined) {
      const q = queueByChannel.get(input.channelId) ?? [];
      if (q.length >= MAX_QUEUE_PER_CHANNEL) {
        // Soft-reject — the caller (discord-bot) reacts 💥 and the user
        // sees the failure. Better than letting the queue grow unbounded.
        reject(new Error(
          `side-session queue for channel ${input.channelId} is full (${q.length} >= ${MAX_QUEUE_PER_CHANNEL}); /btw refused`,
        ));
        return;
      }
      q.push({
        channelId: input.channelId,
        payload: input.payload,
        channelHistoryProvider: input.channelHistoryProvider,
        mainSessionLookup: input.mainSessionLookup,
        resolve,
        reject,
      });
      queueByChannel.set(input.channelId, q);
      input.onQueued?.();
      return;
    }

    // Slot free — reserve it synchronously, then spawn.
    inFlightByChannel.set(input.channelId, SLOT_RESERVED_SENTINEL);
    input.onAck?.();
    spawnAndTrack(input.channelId, {
      channelId: input.channelId,
      payload: input.payload,
      channelHistoryProvider: input.channelHistoryProvider,
      mainSessionLookup: input.mainSessionLookup,
      resolve,
      reject,
    });
  });
}

async function spawnAndTrack(channelId: string, pending: PendingSideTurn): Promise<void> {
  // Build the seeded prompt at spawn time so queued /btw calls see fresh
  // channel history and a fresh main-session lastAssistantText snapshot.
  let history = "";
  try {
    history = await pending.channelHistoryProvider();
  } catch {
    history = "";
  }
  let mainLastAssistantText = "";
  const mainSessionId = pending.mainSessionLookup();
  if (mainSessionId) {
    const mainSession = getSession(mainSessionId);
    if (mainSession) {
      mainLastAssistantText = mainSession.lastAssistantText || "";
    }
  }

  const prompt = seedSidePrompt({
    channelHistory: history,
    mainLastAssistantText,
    payload: pending.payload,
  });

  let session: Session;
  try {
    // Spawn ephemerally — `ephemeral: true` keeps this session out of
    // sessions.json. The Session is held in the runner's in-memory map for
    // the duration of the turn; ephemeral entries accumulate over the
    // process lifetime (bounded by /btw traffic, cleared on restart).
    session = createSession(prompt, false, false, null, { ephemeral: true });
  } catch (err) {
    // Spawn failed — we MUST free the reserved slot AND drain the next
    // queued /btw, otherwise everything queued behind us is stuck.
    inFlightByChannel.delete(channelId);
    pending.reject(err);
    drainNext(channelId);
    return;
  }

  // Replace the slot reservation with the real session id.
  inFlightByChannel.set(channelId, session.id);
  pending.resolve(session.id);

  // Listen for terminal status on this side session. We use the per-session
  // `status:<id>` event to avoid bumping the global "status" listener
  // count under bursts of /btw traffic. On terminal, free the slot and
  // drain the next queued /btw if any.
  const statusEvent = `status:${session.id}`;
  const onStatus = (status: string) => {
    if (status !== "complete" && status !== "error" && status !== "idle") return;
    sessionEvents.off(statusEvent, onStatus);
    inFlightByChannel.delete(channelId);
    drainNext(channelId);
  };
  sessionEvents.on(statusEvent, onStatus);
}

function drainNext(channelId: string): void {
  const q = queueByChannel.get(channelId);
  if (!q || q.length === 0) {
    queueByChannel.delete(channelId);
    return;
  }
  const next = q.shift()!;
  if (q.length === 0) queueByChannel.delete(channelId);
  // Re-reserve the slot synchronously for the drained turn — same race
  // protection as the initial enqueueSideTurn path.
  inFlightByChannel.set(channelId, SLOT_RESERVED_SENTINEL);
  // Spawn the next pending turn. spawnAndTrack handles in-flight bookkeeping
  // + recursive drain on terminal (and on spawn failure).
  void spawnAndTrack(channelId, next);
}

// --- Test hook ---

/**
 * Reset the per-channel in-flight markers and queues. Tests only — never
 * call from production code paths. Used by scripts/test-side-session-queue.ts
 * to start each scenario from a clean slate without spinning up a fresh
 * runner module.
 */
export function _resetSideSessionStateForTests(): void {
  inFlightByChannel.clear();
  queueByChannel.clear();
}
