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
 *    Discord message), the list+delete cost is bounded (≤501 drawers per
 *    channel even in the worst case), and it keeps the MemPalace contract
 *    unchanged. ADR-0004 (activity-bounded retention) governs this choice.
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
 */

import {
  isEnabled,
  mpAddDrawer,
  mpGetDrawer,
  mpListDrawers,
  mpDeleteDrawer,
  mpSearch,
  type DrawerEntry,
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
    return mpSearch(query, opts);
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
 * Peek at a (possibly preview-truncated) envelope and recover ts as a
 * millisecond epoch suitable for sorting. `enforceCap` and the sort step in
 * `readVerbatimWindow` only need ts, so we tolerate truncation here rather
 * than dropping the entry. Returns 0 (sorts oldest, evicted first) for
 * undecodable / malformed / NaN-date entries.
 */
function peekEnvelopeTs(content: string): number {
  if (typeof content !== "string" || content.length === 0) return 0;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.ts === "string") {
      const t = new Date(parsed.ts).getTime();
      return Number.isFinite(t) ? t : 0;
    }
  } catch {
    // Truncated preview — fall through to regex fallback.
  }
  const m = content.match(/"ts"\s*:\s*"([^"]+)"/);
  if (m && m[1]) {
    const t = new Date(m[1]).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
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
  channelLocks.set(
    channelId,
    result.then(
      () => {},
      () => {},
    ),
  );
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
        console.error(
          `[channel-transcript] addDrawer failed for room=${channelId}: ${result.error ?? "unknown"}`,
        );
        return;
      }
      await enforceCap(channelId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel-transcript] writeTurn failed: ${msg}`);
    }
  });
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
    // actually return.
    const annotatedAuthors = drawers
      .map((d) => {
        const m = d.text.match(/"author"\s*:\s*"([^"]+)"/);
        const author = m && m[1] ? m[1] : "";
        return { d, ts: peekEnvelopeTs(d.text), author };
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
    return results
      .map(entryFromSearchResult)
      .filter((e): e is TranscriptEntry => e !== null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[channel-transcript] searchProse failed: ${msg}`);
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
 * Bounded so a long-running process can't grow this without limit.
 */
const SEEN_INCOMING_IDS_CAP = 5000;
const seenIncomingIds = new Set<string>();
const seenIncomingOrder: string[] = [];

function markSeen(messageId: string): boolean {
  if (seenIncomingIds.has(messageId)) return false;
  seenIncomingIds.add(messageId);
  seenIncomingOrder.push(messageId);
  while (seenIncomingOrder.length > SEEN_INCOMING_IDS_CAP) {
    const evicted = seenIncomingOrder.shift();
    if (evicted) seenIncomingIds.delete(evicted);
  }
  return true;
}

export function _resetSeenIncomingForTesting(): void {
  seenIncomingIds.clear();
  seenIncomingOrder.length = 0;
}

/**
 * Capture an incoming Discord message into the transcript wing. Idempotent
 * on `messageId` — repeated calls (e.g. from multiple BotInstances handling
 * the same MessageCreate event) are no-ops after the first.
 *
 * Oversize-message filtering happens upstream (slice #5) before this is
 * called.
 */
export async function transcribeIncoming(
  channelId: string,
  messageId: string,
  author: string,
  text: string,
  timestamp: string,
): Promise<void> {
  if (!markSeen(messageId)) return;
  await writeTurn(channelId, author, text, timestamp);
}

/**
 * Capture an outgoing bot reply (the bot's own utterance) into the transcript
 * wing. No dedupe here: the bot layer calls this exactly once per send. The
 * `author` is the bot's display name or user id — chosen to mirror the
 * incoming author convention so readVerbatimWindow's exclude-by-author
 * filter works symmetrically.
 */
export async function transcribeOutgoing(
  channelId: string,
  author: string,
  text: string,
  timestamp: string,
): Promise<void> {
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
async function enforceCap(channelId: string): Promise<void> {
  // List with generous slack so any real-world backlog (existing data,
  // delete failures from prior runs, multi-process writes pre-mutex) is
  // catchable in one pass — the previous CAP+1 limit could only delete one
  // drawer per write, never converging if the channel was further over.
  const drawers = await backend.listDrawers({
    wing: CHANNEL_TRANSCRIPT_WING,
    room: channelId,
    limit: CHANNEL_TRANSCRIPT_CAP * 2 + 1,
  });
  if (drawers.length <= CHANNEL_TRANSCRIPT_CAP) return;

  // Order oldest-first by ts peeked from the (possibly preview-truncated)
  // envelope. peekEnvelopeTs returns 0 for undecodable / NaN-date / missing
  // ts entries — those sort first so they're the first evicted.
  const annotated = drawers.map((d) => ({ d, ts: peekEnvelopeTs(d.text) }));
  annotated.sort((a, b) => a.ts - b.ts);

  const overflow = annotated.length - CHANNEL_TRANSCRIPT_CAP;
  for (let i = 0; i < overflow; i++) {
    const id = annotated[i]?.d.id;
    if (!id) continue;
    try {
      await backend.deleteDrawer(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[channel-transcript] evict failed for drawer ${id}: ${msg}`,
      );
    }
  }
}
