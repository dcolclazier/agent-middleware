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
  author: string;
  ts: string;
  text: string;
}

function encodeEnvelope(author: string, timestamp: string, text: string): string {
  const env: Envelope = { v: 1, author, ts: timestamp, text };
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
      return { v: 1, author: parsed.author, ts: parsed.ts, text: parsed.text };
    }
  } catch {
    // Not JSON — fall through.
  }
  return null;
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist one Discord turn into the channel transcript wing.
 *
 * Writes a drawer to `wing="conversation"`, `room=channelId` whose content
 * is a JSON envelope of {author, timestamp, text}. After the write, if the
 * channel now holds more than CHANNEL_TRANSCRIPT_CAP transcript drawers,
 * the oldest are deleted (drop-oldest-on-write). Failure paths (write or
 * delete) are logged but never thrown — transcript capture must not break
 * the bot's reply path.
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
    const entries = drawers
      .map(entryFromDrawer)
      .filter((e): e is TranscriptEntry => e !== null)
      .filter((e) => e.author !== excludeAuthor);
    // Sort oldest-to-newest by timestamp.
    entries.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    // Take the last k (most recent).
    return entries.slice(-k);
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
  // Fetch one over the cap to detect the overflow condition.
  const drawers = await backend.listDrawers({
    wing: CHANNEL_TRANSCRIPT_WING,
    room: channelId,
    limit: CHANNEL_TRANSCRIPT_CAP + 1,
  });
  if (drawers.length <= CHANNEL_TRANSCRIPT_CAP) return;

  // Order oldest-first by timestamp from the envelope (falls back to
  // listing order for legacy/undecodable entries — those go first so they
  // are the first evicted).
  const annotated = drawers.map((d) => {
    const env = decodeEnvelope(d.text);
    const ts = env ? new Date(env.ts).getTime() : 0;
    return { d, ts };
  });
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
