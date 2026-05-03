/**
 * channel-transcript.ts — per-channel shared transcript foundation.
 *
 * Captures every Discord message (incoming user/bot AND outgoing bot reply)
 * in a watched channel as a drawer in the MemPalace `conversation` wing,
 * room=<channelId>. This is the cross-agent shared memory layer: a decision
 * NemoClaw made earlier in the channel becomes visible to Qwen on the next
 * turn through `readVerbatimWindow` (slice #6) and `searchProse` (slice #7).
 *
 * Design notes:
 *
 * 1. Wing/room conventions are HIDDEN behind this module. Callers pass
 *    channelId; they never construct wing="conversation" themselves. This is
 *    the deep-module property the brief calls for: a small typed surface
 *    (writeTurn, readVerbatimWindow, searchProse) over a richer policy
 *    (eviction, format, failure handling).
 *
 * 2. The 500-message-per-channel cap is enforced CLIENT-SIDE. The MemPalace
 *    HTTP API as it exists today exposes /drawer (POST), /drawer/:id (DELETE),
 *    /drawers/list (POST), and /search (POST), with no per-(wing,room) cap
 *    setting on the server. Adding one would require changes to the MemPalace
 *    server outside this repo's control. Client-side cap is the right
 *    trade-off for slice #2: transcript writes are infrequent (one per
 *    Discord message), and it keeps the MemPalace contract unchanged.
 *    Cap-enforcement cost per writeTurn is bounded by `enforceCap`'s paged
 *    loop: at most `ENFORCE_CAP_MAX_ITERATIONS` (5) list passes of up to
 *    `CAP*2+1` (1001) drawers each, plus a delete per overflow drawer.
 *    Steady-state (channel at-or-near cap) is one list + at most one delete.
 *    ADR-0004 (activity-bounded retention) governs this choice.
 *
 * 3. Each drawer's content is a JSON envelope of {author, timestamp, text}.
 *    We do this rather than relying on MemPalace metadata because the list
 *    endpoint returns only a content_preview and the search endpoint returns
 *    only a flat text field — embedding the metadata in content survives
 *    both and lets readVerbatimWindow/searchProse reconstruct typed entries
 *    without per-drawer GETs.
 *
 * 4. MEMPALACE_ENABLED=false makes every call a no-op (matches mempalace-
 *    client.ts). This is checked LAZILY on each call so tests can flip the
 *    env var between cases without re-importing the module.
 *
 * 5. The backend is injectable via _setBackendForTesting (mirrors the
 *    _resetCacheForTesting pattern from src/qwen-persona.ts introduced in
 *    PR #9). The default backend wraps mempalace-client.ts; tests substitute
 *    an in-memory backend.
 *
 * 6. Memory-offline warning (issue #8): a per-channel boolean tracks whether
 *    the in-channel "memory offline" notice has already been posted in the
 *    current outage. The first failure (mpAddDrawer/mpSearch/searchProse
 *    via this module) fires a notifier callback once; subsequent failures
 *    on the same channel are silent until the next successful call clears
 *    the flag. The notifier is wired by the bot layer (see
 *    discord-bot.ts:startDiscordBot) — channel-transcript itself has no
 *    Discord client, so the API is callback-based.
 */

import {
  isEnabled,
  mpAddDrawer,
  mpGetDrawer,
  mpListDrawers,
  mpDeleteDrawer,
  mpSearchResult,
  type DrawerEntry,
  type MpResult,
  type SearchResult,
} from "./mempalace-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MemPalace wing for cross-agent channel transcripts. */
export const CHANNEL_TRANSCRIPT_WING = "conversation";

/**
 * Per-channel cap on transcript drawers. ADR-0004 (activity-bounded
 * transcript retention): drop-oldest-on-write at 500. No byte cap; oversize
 * messages are filtered upstream (slice #5).
 */
export const CHANNEL_TRANSCRIPT_CAP = 500;

/**
 * Canonical in-channel notice posted on the first MemPalace failure per
 * outage per channel. Issue #8: warn the user once that recall is offline so
 * agents speaking past each other have an interpretable cause.
 */
export const MEMORY_OFFLINE_WARNING =
  "⚠ memory offline — operating context-blind";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A reconstructed transcript entry returned by read/search. */
export interface TranscriptEntry {
  channelId: string;
  author: string;
  text: string;
  /** ISO 8601. */
  timestamp: string;
}

/**
 * Backend the module uses to talk to drawer storage. Production wires this
 * to mempalace-client.ts; tests can install an in-memory backend.
 */
export interface TranscriptBackend {
  addDrawer(
    wing: string,
    room: string,
    content: string,
  ): Promise<{ success: boolean; drawer_id?: string; error?: string }>;
  listDrawers(opts?: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }): Promise<DrawerEntry[]>;
  /**
   * Fetch one drawer's *full* content by id. `listDrawers` returns
   * `content_preview` (server-truncated) — when the envelope JSON exceeds
   * that preview, decode fails and we lose the entry. `readVerbatimWindow`
   * uses this to recover full content for the window it actually returns.
   */
  getDrawer(id: string): Promise<DrawerEntry | null>;
  deleteDrawer(id: string): Promise<boolean>;
  /**
   * Returns the raw search hits on success (which may be empty), or throws on
   * timeout / network error. The throw — vs an empty array — is what lets
   * `searchProse` distinguish "no matches" from "MemPalace down" (issue #8).
   */
  search(
    query: string,
    opts?: { wing?: string; room?: string; limit?: number },
  ): Promise<SearchResult[]>;
}

// ---------------------------------------------------------------------------
// Default backend — thin wrapper over mempalace-client.
// ---------------------------------------------------------------------------

const defaultBackend: TranscriptBackend = {
  async addDrawer(wing, room, content) {
    const r = await mpAddDrawer(wing, room, content, { added_by: "transcript" });
    return { success: r.success, drawer_id: r.drawer_id, error: r.error };
  },
  async listDrawers(opts) {
    return mpListDrawers(opts);
  },
  async getDrawer(id) {
    const r = await mpGetDrawer(id);
    return r.drawer ?? null;
  },
  async deleteDrawer(id) {
    return mpDeleteDrawer(id);
  },
  async search(query, opts) {
    // Use the tagged-variant API so failure → throw → searchProse can fire
    // the memory-offline warning. The plain `mpSearch` swallows errors as []
    // and would lose the distinction (issue #8).
    const r: MpResult<SearchResult[]> = await mpSearchResult(query, opts);
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  },
};

let backend: TranscriptBackend = defaultBackend;

// ---------------------------------------------------------------------------
// Test-state hooks (mirrors src/qwen-persona.ts:_resetCacheForTesting from
// PR #9). Production code never calls these.
// ---------------------------------------------------------------------------

export function _setBackendForTesting(b: TranscriptBackend): void {
  backend = b;
}

export function _resetBackendForTesting(): void {
  backend = defaultBackend;
}

// ---------------------------------------------------------------------------
// Memory-offline warning (issue #8). Channel-transcript is the integration
// point for MemPalace calls scoped to a Discord channel; the warning logic
// lives here (rather than in mempalace-client.ts) because the client speaks
// MemPalace primitives, not channels, and so has no place to track
// per-channel outage state. The brief authorises either location;
// channel-transcript is preferred because it already owns the channelId
// boundary.
//
// Reporting points: writeTurn (failure on every Discord message routed
// through bot-instance) and searchProse (failure on a channel-scoped
// topical query). readVerbatimWindow does NOT report — verbatim reads
// happen on the response path, after writeTurn has already fired the
// warning for the same outage. Wiring reads in too would only matter for
// the corner case of "MP went down strictly between writeTurn-success and
// readVerbatimWindow on the same turn," and the next writeTurn/searchProse
// would catch it. Issue #8 covers the dominant first-failure path.
//
// State: per-channel "warning has been posted in this outage" flag. On the
// next successful call the flag clears so a subsequent outage re-fires once.
// Notifier: optional callback the bot layer installs to post the in-channel
// notice. When unset (e.g. middleware HTTP routes hit channel-transcript
// outside a Discord context), failures are still logged but no message is
// emitted.
// ---------------------------------------------------------------------------

export type MemoryOfflineNotifier = (
  channelId: string,
  message: string,
) => void | Promise<void>;

const memoryOfflineWarned = new Map<string, boolean>();
let memoryOfflineNotifier: MemoryOfflineNotifier | null = null;

export function setMemoryOfflineNotifier(n: MemoryOfflineNotifier | null): void {
  memoryOfflineNotifier = n;
}

export function _resetMemoryOfflineStateForTesting(): void {
  memoryOfflineWarned.clear();
}

/**
 * Mark a MemPalace call for `channelId` as failed. If this is the FIRST
 * failure since the last success, fires the notifier once. Subsequent
 * failures while the flag is set are silent.
 *
 * Notifier errors are caught here so the bot's reply path is never broken
 * by a Discord post failure (issue #8 acceptance: bot must still respond).
 */
function reportMpFailure(channelId: string, reason: string): void {
  console.error(
    `[channel-transcript] MemPalace failure for room=${channelId}: ${reason}`,
  );
  if (memoryOfflineWarned.get(channelId) === true) return;
  const notifier = memoryOfflineNotifier;
  if (!notifier) return;
  // Mark warned only when we actually attempt to notify, and roll the flag
  // back if the attempt fails. Setting it unconditionally would let two
  // failure modes permanently suppress later warnings until a MemPalace
  // success clears the flag:
  //   (a) failure in a non-Discord context (e.g. HTTP route hits writeTurn
  //       before bot wiring sets the notifier),
  //   (b) the notifier itself throws/rejects (Discord outage, missing
  //       permissions in the channel) — no notice was posted, so the next
  //       MemPalace failure should retry posting.
  memoryOfflineWarned.set(channelId, true);
  try {
    const r = notifier(channelId, MEMORY_OFFLINE_WARNING);
    if (r && typeof (r as Promise<void>).then === "function") {
      (r as Promise<void>).catch((err: unknown) => {
        memoryOfflineWarned.delete(channelId);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[channel-transcript] memory-offline notifier rejected: ${msg}`,
        );
      });
    }
  } catch (err: unknown) {
    memoryOfflineWarned.delete(channelId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[channel-transcript] memory-offline notifier threw: ${msg}`);
  }
}

/**
 * Mark a MemPalace call for `channelId` as successful. Clears the
 * per-channel offline flag so a fresh outage re-fires the warning once.
 * Empty-but-successful results are also "success" — only timeouts / errors
 * trigger the warning.
 */
function reportMpSuccess(channelId: string): void {
  if (memoryOfflineWarned.get(channelId) === true) {
    memoryOfflineWarned.delete(channelId);
  }
}

// ---------------------------------------------------------------------------
// Envelope (de)serialisation. Compact JSON keeps drawer content searchable
// while letting us recover {author, timestamp, text} losslessly.
// ---------------------------------------------------------------------------

interface Envelope {
  v: 1;
  ts: string;
  author: string;
  text: string;
}

function encodeEnvelope(author: string, timestamp: string, text: string): string {
  // Key order is load-bearing: `mpListDrawers` returns a server-truncated
  // `content_preview`. Putting `ts` and `author` ahead of the (potentially
  // long) `text` field keeps those fields recoverable by `peekEnvelope*`
  // even when the preview is truncated mid-`text`.
  const env: Envelope = { v: 1, ts: timestamp, author, text };
  return JSON.stringify(env);
}

/**
 * Decode a drawer-content envelope. Tolerates legacy/malformed entries by
 * returning null — callers skip those rather than crashing the whole read.
 */
function decodeEnvelope(content: string): Envelope | null {
  if (typeof content !== "string" || content.length === 0) return null;
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.author === "string" &&
      typeof parsed.ts === "string" &&
      typeof parsed.text === "string"
    ) {
      return { v: 1, ts: parsed.ts, author: parsed.author, text: parsed.text };
    }
  } catch {
    // Not JSON — fall through.
  }
  return null;
}

/**
 * Peek at a (possibly preview-truncated) envelope and recover ts + author
 * without requiring full JSON parse. JSON.parse is preferred (JSON-safe for
 * escaped quotes / backslashes in author names); the regex fallback is only
 * used when the preview is truncated mid-JSON. ts of 0 sorts oldest /
 * evicted first; author of "" means "unrecoverable". The regex paths are
 * best-effort under truncation — they do not handle every escape sequence.
 */
function peekEnvelope(content: string): { ts: number; author: string } {
  if (typeof content !== "string" || content.length === 0) {
    return { ts: 0, author: "" };
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      let ts = 0;
      let author = "";
      if (typeof parsed.ts === "string") {
        const t = new Date(parsed.ts).getTime();
        if (Number.isFinite(t)) ts = t;
      }
      if (typeof parsed.author === "string") author = parsed.author;
      return { ts, author };
    }
  } catch {
    // Truncated preview — fall through to regex (best-effort, JSON-unsafe).
  }
  let ts = 0;
  let author = "";
  const tsMatch = content.match(/"ts"\s*:\s*"([^"]+)"/);
  if (tsMatch && tsMatch[1]) {
    const t = new Date(tsMatch[1]).getTime();
    if (Number.isFinite(t)) ts = t;
  }
  const authorMatch = content.match(/"author"\s*:\s*"([^"]+)"/);
  if (authorMatch && authorMatch[1]) author = authorMatch[1];
  return { ts, author };
}

function peekEnvelopeTs(content: string): number {
  return peekEnvelope(content).ts;
}

function entryFromDrawer(d: DrawerEntry): TranscriptEntry | null {
  const env = decodeEnvelope(d.text);
  if (!env) return null;
  return {
    channelId: d.room,
    author: env.author,
    text: env.text,
    timestamp: env.ts,
  };
}

function entryFromSearchResult(r: SearchResult): TranscriptEntry | null {
  const env = decodeEnvelope(r.text);
  if (!env) return null;
  return {
    channelId: r.room,
    author: env.author,
    text: env.text,
    timestamp: env.ts,
  };
}

// ---------------------------------------------------------------------------
// Per-channel write serialisation. The Discord layer fires `writeTurn` calls
// without awaiting them (`void transcribeIncoming(...)` in bot-instance.ts),
// so two messages in the same channel can have overlapping
// add → enforceCap → list → delete sequences. Without serialisation the cap
// drifts above CHANNEL_TRANSCRIPT_CAP and ADR-0004's "atomic eviction"
// contract breaks. We chain each channel's writes through a per-channel
// promise so add+enforceCap is mutually exclusive within a process.
// ---------------------------------------------------------------------------

const channelLocks = new Map<string, Promise<void>>();

function withChannelLock<T>(
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = channelLocks.get(channelId) ?? Promise.resolve();
  const result = prev.then(() => fn());
  // Swallow rejection on the lock chain so one failed write doesn't poison
  // every subsequent write for that channel.
  const settled = result.then(
    () => {},
    () => {},
  );
  channelLocks.set(channelId, settled);
  // When this chain settles, drop the entry only if no later writer chained
  // on top of us. Bounds the map to the active write set (rather than the
  // lifetime channel set) for processes that see many ephemeral channelIds.
  void settled.finally(() => {
    if (channelLocks.get(channelId) === settled) {
      channelLocks.delete(channelId);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist one Discord turn into the channel transcript wing.
 *
 * Writes a drawer to `wing="conversation"`, `room=channelId` whose content
 * is a JSON envelope of {author, timestamp, text}. After the write, if the
 * channel now holds more than CHANNEL_TRANSCRIPT_CAP transcript drawers,
 * the oldest are deleted (drop-oldest-on-write). Add and cap-enforcement
 * are serialised per channel (see `withChannelLock`). Failure paths (write
 * or delete) are logged but never thrown — transcript capture must not
 * break the bot's reply path.
 *
 * No-op when MEMPALACE_ENABLED is not "true".
 */
export async function writeTurn(
  channelId: string,
  author: string,
  text: string,
  timestamp: string,
): Promise<void> {
  if (!isEnabled()) return;
  return withChannelLock(channelId, async () => {
    try {
      const content = encodeEnvelope(author, timestamp, text);
      const result = await backend.addDrawer(
        CHANNEL_TRANSCRIPT_WING,
        channelId,
        content,
      );
      if (!result.success) {
        // Soft failure (HTTP error caught by mempalace-client). Issue #8.
        reportMpFailure(channelId, result.error ?? "unknown");
        return;
      }
      // Successful write — clear any prior offline flag for this channel.
      reportMpSuccess(channelId);
      await enforceCap(channelId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel-transcript] writeTurn failed: ${msg}`);
      reportMpFailure(channelId, msg);
    }
  });
}

/**
 * Resolve when all in-flight `transcribeIncoming` / `writeTurn` calls for
 * `channelId` have settled (succeeded or failed). Use this as a write
 * barrier before reading the verbatim window so the read sees writes that
 * the Discord layer fired-and-forgot for the message currently driving the
 * turn.
 *
 * Implementation note: the per-channel lock chain (`channelLocks`) holds
 * the latest settled-or-pending tail of each channel's serial write queue.
 * Awaiting it gives us an unconditional "all prior writes finished"
 * barrier without coupling readers to MemPalace round-trip latency on the
 * write path itself (writes remain fire-and-forget at the call site).
 *
 * No-op (resolves immediately) when no writes are pending or have ever
 * been issued for this channel.
 */
export function awaitPendingWrites(channelId: string): Promise<void> {
  return channelLocks.get(channelId) ?? Promise.resolve();
}

/**
 * Return the most recent K transcript entries for `channelId` whose author
 * is NOT `excludeAuthor`. Result is ordered oldest-to-newest so callers can
 * splice it directly into a chronological prompt.
 *
 * No-op (returns []) when MEMPALACE_ENABLED is not "true".
 */
export async function readVerbatimWindow(
  channelId: string,
  excludeAuthor: string,
  k: number,
): Promise<TranscriptEntry[]> {
  if (!isEnabled()) return [];
  if (k <= 0) return [];
  try {
    // Pull a generous slice (up to the cap) and filter client-side. The
    // MemPalace list endpoint does not support author filtering today.
    const drawers = await backend.listDrawers({
      wing: CHANNEL_TRANSCRIPT_WING,
      room: channelId,
      limit: CHANNEL_TRANSCRIPT_CAP,
    });
    // List returns content_preview, so envelope.text may be truncated and
    // decodeEnvelope may return null. Sort by ts (peeked from the truncated
    // preview) before slicing, then re-fetch full content for the K we
    // actually return. peekEnvelope tries JSON.parse first (JSON-safe for
    // escaped quotes / backslashes in usernames) and falls back to a regex
    // only on parse failure.
    const annotatedAuthors = drawers
      .map((d) => {
        const env = peekEnvelope(d.text);
        return { d, ts: env.ts, author: env.author };
      })
      .filter((a) => a.author !== "" && a.author !== excludeAuthor);
    annotatedAuthors.sort((a, b) => a.ts - b.ts);
    const candidates = annotatedAuthors.slice(-k);

    // Resolve each candidate to a full TranscriptEntry. Try the preview
    // first (cheap path — succeeds whenever the envelope fit in the
    // preview); fall back to a single-drawer GET when JSON.parse fails.
    const entries: TranscriptEntry[] = [];
    for (const a of candidates) {
      const fromPreview = entryFromDrawer(a.d);
      if (fromPreview) {
        entries.push(fromPreview);
        continue;
      }
      const full = await backend.getDrawer(a.d.id);
      if (!full) continue;
      const fromFull = entryFromDrawer(full);
      if (fromFull) entries.push(fromFull);
    }
    return entries;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[channel-transcript] readVerbatimWindow failed: ${msg}`);
    return [];
  }
}

/**
 * Semantic search over the conversation wing. When `channelId` is provided,
 * the search is scoped to that channel's room; otherwise it covers every
 * channel's transcripts in the wing. Returns at most `limit` entries
 * (default 5).
 *
 * No-op (returns []) when MEMPALACE_ENABLED is not "true".
 */
export async function searchProse(
  query: string,
  channelId?: string,
  limit = 5,
): Promise<TranscriptEntry[]> {
  if (!isEnabled()) return [];
  try {
    const opts: { wing: string; room?: string; limit: number } = {
      wing: CHANNEL_TRANSCRIPT_WING,
      limit,
    };
    if (channelId !== undefined) opts.room = channelId;
    const results = await backend.search(query, opts);
    // Issue #8: empty result is a success — only the throw path is a failure.
    if (channelId !== undefined) reportMpSuccess(channelId);
    return results
      .map(entryFromSearchResult)
      .filter((e): e is TranscriptEntry => e !== null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[channel-transcript] searchProse failed: ${msg}`);
    if (channelId !== undefined) reportMpFailure(channelId, msg);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Bot-routing helpers — single integration point for the Discord layer.
// The brief asks the routing layer to capture incoming AND outgoing turns
// without per-agent code paths. These wrappers live in this module so the
// dedupe + author conventions stay in one place.
// ---------------------------------------------------------------------------

/**
 * In-process LRU of (messageId) keys that have already been transcribed this
 * run. Multiple BotInstances live in one process and all receive the same
 * Discord MessageCreate events; without this dedupe, every message would be
 * written N times (once per BotInstance whose intents matched).
 *
 * Backed by a single `Map` so `has` / `set` / oldest-eviction are all O(1)
 * (Map iteration follows insertion order, so `keys().next().value` is the
 * oldest entry). Bounded so a long-running process can't grow this without
 * limit.
 */
const SEEN_INCOMING_IDS_CAP = 5000;
const seenIncoming = new Map<string, true>();

function markSeen(messageId: string): boolean {
  if (seenIncoming.has(messageId)) return false;
  seenIncoming.set(messageId, true);
  if (seenIncoming.size > SEEN_INCOMING_IDS_CAP) {
    const oldest = seenIncoming.keys().next().value;
    if (oldest !== undefined) seenIncoming.delete(oldest);
  }
  return true;
}

export function _resetSeenIncomingForTesting(): void {
  seenIncoming.clear();
}

/**
 * Capture a Discord message into the transcript wing. Idempotent on
 * `messageId`: repeated calls (e.g. from sibling BotInstances handling the
 * same MessageCreate event, OR from the bot's own send-side capture
 * arriving before/after siblings see the event) are no-ops after the first.
 *
 * Use the same call shape for both directions — the bot's own send must
 * pass the sent `Message.id` and `Message.author.username` so its drawer is
 * deduped against the sibling-bot incoming view of the same Discord
 * message. Oversize-message filtering happens upstream (slice #5) before
 * this is called.
 */
export async function transcribeIncoming(
  channelId: string,
  messageId: string,
  author: string,
  text: string,
  timestamp: string,
): Promise<void> {
  // Flag check FIRST so the dedupe LRU is not mutated when the module is
  // disabled — otherwise an id seen while disabled would be silently skipped
  // when MemPalace later comes back online.
  if (!isEnabled()) return;
  if (!markSeen(messageId)) return;
  await writeTurn(channelId, author, text, timestamp);
}

// ---------------------------------------------------------------------------
// Cap enforcement (client-side, post-write)
// ---------------------------------------------------------------------------

/**
 * After a write, if the channel exceeds CHANNEL_TRANSCRIPT_CAP transcript
 * drawers, delete the oldest until it doesn't. Layer B fact rooms (qwen
 * wing — `decision`, `naming`, `user_preference`, `canon_observation`) are
 * NEVER touched here: the list query is scoped to wing="conversation",
 * room=channelId, so fact drawers are out of scope by construction.
 */
/**
 * Bound on the convergence loop in `enforceCap`. A pathological channel
 * (e.g. >>CAP*2 backlog from prior delete failures or multi-process writes)
 * is paged through across this many iterations. Beyond that, we log and
 * return — the next writeTurn will resume convergence.
 */
const ENFORCE_CAP_MAX_ITERATIONS = 5;

async function enforceCap(channelId: string): Promise<void> {
  const LIST_LIMIT = CHANNEL_TRANSCRIPT_CAP * 2 + 1;
  for (let iter = 0; iter < ENFORCE_CAP_MAX_ITERATIONS; iter++) {
    const drawers = await backend.listDrawers({
      wing: CHANNEL_TRANSCRIPT_WING,
      room: channelId,
      limit: LIST_LIMIT,
    });
    if (drawers.length <= CHANNEL_TRANSCRIPT_CAP) return;

    // Order oldest-first by ts peeked from the (possibly preview-truncated)
    // envelope. peekEnvelopeTs returns 0 for undecodable / NaN-date /
    // missing ts entries — those sort first so they're the first evicted.
    const annotated = drawers.map((d) => ({ d, ts: peekEnvelopeTs(d.text) }));
    annotated.sort((a, b) => a.ts - b.ts);

    const overflow = annotated.length - CHANNEL_TRANSCRIPT_CAP;
    let evictedThisIter = 0;
    for (let i = 0; i < overflow; i++) {
      const id = annotated[i]?.d.id;
      if (!id) continue;
      try {
        const ok = await backend.deleteDrawer(id);
        if (ok) {
          evictedThisIter++;
        } else {
          // Default backend (mempalace-client.ts:208) returns false on soft
          // failure (HTTP error) without throwing — surface those.
          console.error(
            `[channel-transcript] deleteDrawer returned false for drawer ${id} (room=${channelId})`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[channel-transcript] evict failed for drawer ${id}: ${msg}`,
        );
      }
    }
    // Two early-exit conditions: (1) we got the full set in one list (so
    // we know nothing remains beyond what we just processed), or (2) no
    // delete actually succeeded this iter (further iterations would loop
    // on the same un-deletable drawers).
    if (drawers.length < LIST_LIMIT) return;
    if (evictedThisIter === 0) {
      console.warn(
        `[channel-transcript] enforceCap made no progress for room=${channelId}; channel may remain over cap`,
      );
      return;
    }
  }
  console.warn(
    `[channel-transcript] enforceCap hit max iterations (${ENFORCE_CAP_MAX_ITERATIONS}) for room=${channelId}; next writeTurn will resume convergence`,
  );
}
