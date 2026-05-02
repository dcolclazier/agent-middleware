// Smoke tests for src/channel-transcript.ts (Slice 2 — channel transcript foundation).
// Run: npx tsx scripts/test-channel-transcript.ts
//
// The module under test exposes three async functions hiding the wing/room
// conventions, eviction policy, and MemPalace failure handling:
//   - writeTurn(channelId, author, text, timestamp): Promise<void>
//   - readVerbatimWindow(channelId, excludeAuthor, k): Promise<TranscriptEntry[]>
//   - searchProse(query, channelId?, limit): Promise<TranscriptEntry[]>
//
// We don't talk to a real MemPalace server here — the module exposes a
// `_setBackendForTesting` hook (mirroring the test-state pattern PR #9
// introduced for qwen-persona) that lets us substitute an in-memory backend.
// The default backend wraps mempalace-client.ts; the in-memory backend is
// only ever installed by this test script.

import {
  writeTurn,
  readVerbatimWindow,
  searchProse,
  transcribeIncoming,
  CHANNEL_TRANSCRIPT_CAP,
  CHANNEL_TRANSCRIPT_WING,
  MEMORY_OFFLINE_WARNING,
  _setBackendForTesting,
  _resetBackendForTesting,
  _resetSeenIncomingForTesting,
  _resetMemoryOfflineStateForTesting,
  setMemoryOfflineNotifier,
  type TranscriptBackend,
  type TranscriptEntry,
} from "../src/channel-transcript.js";

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

// ---------------------------------------------------------------------------
// In-memory test backend. Mirrors the surface of the MemPalace client just
// closely enough that the module under test can't tell the difference.
// ---------------------------------------------------------------------------

interface StoredDrawer {
  id: string;
  wing: string;
  room: string;
  content: string;
  created_at: string;
}

function makeBackend(): TranscriptBackend & {
  drawers: StoredDrawer[];
  searchSpy: { query: string; wing?: string; room?: string; limit?: number }[];
} {
  const drawers: StoredDrawer[] = [];
  const searchSpy: { query: string; wing?: string; room?: string; limit?: number }[] = [];
  let counter = 0;
  return {
    drawers,
    searchSpy,
    async addDrawer(wing, room, content) {
      counter++;
      const id = `mock-${counter}`;
      drawers.push({
        id,
        wing,
        room,
        content,
        created_at: new Date().toISOString(),
      });
      return { success: true, drawer_id: id };
    },
    async listDrawers(opts) {
      // Filter by wing/room when provided, return in insertion order.
      let filtered = drawers.slice();
      if (opts?.wing) filtered = filtered.filter((d) => d.wing === opts.wing);
      if (opts?.room) filtered = filtered.filter((d) => d.room === opts.room);
      const limit = opts?.limit ?? filtered.length;
      const offset = opts?.offset ?? 0;
      return filtered.slice(offset, offset + limit).map((d) => ({
        id: d.id,
        text: d.content,
        wing: d.wing,
        room: d.room,
        created_at: d.created_at,
      }));
    },
    async getDrawer(id) {
      const d = drawers.find((x) => x.id === id);
      if (!d) return null;
      return {
        id: d.id,
        text: d.content,
        wing: d.wing,
        room: d.room,
        created_at: d.created_at,
      };
    },
    async deleteDrawer(id) {
      const idx = drawers.findIndex((d) => d.id === id);
      if (idx === -1) return false;
      drawers.splice(idx, 1);
      return true;
    },
    async search(query, opts) {
      searchSpy.push({
        query,
        wing: opts?.wing,
        room: opts?.room,
        limit: opts?.limit,
      });
      // Naive substring match for relevance assertions.
      let filtered = drawers.slice();
      if (opts?.wing) filtered = filtered.filter((d) => d.wing === opts.wing);
      if (opts?.room) filtered = filtered.filter((d) => d.room === opts.room);
      const matches = filtered.filter((d) =>
        d.content.toLowerCase().includes(query.toLowerCase()),
      );
      const limit = opts?.limit ?? matches.length;
      return matches.slice(0, limit).map((d) => ({
        text: d.content,
        wing: d.wing,
        room: d.room,
        similarity: 1.0,
        distance: 0,
        created_at: d.created_at,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  const channel = "1234567890";
  const otherChannel = "9876543210";

  // Tests 1–6, 8 require MEMPALACE_ENABLED=true so the no-op path doesn't
  // short-circuit the backend. Test 7 explicitly flips it to "false".
  process.env.MEMPALACE_ENABLED = "true";

  // 1. writeTurn writes one drawer with wing="conversation" and room=channelId.
  sect("1. writeTurn — basic write");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    await writeTurn(channel, "Alice", "Hello world", "2026-04-30T12:00:00Z");
    check("exactly one drawer was written", backend.drawers.length === 1);
    check(
      "wing is 'conversation'",
      backend.drawers[0]?.wing === CHANNEL_TRANSCRIPT_WING,
    );
    check("room equals channelId", backend.drawers[0]?.room === channel);
    const content = backend.drawers[0]?.content ?? "";
    check("content carries author", content.includes("Alice"));
    check(
      "content carries timestamp",
      content.includes("2026-04-30T12:00:00Z"),
    );
    check("content carries text", content.includes("Hello world"));
    _resetBackendForTesting();
  }

  // 2. 500-cap eviction: 600 writes leave exactly 500 drawers, oldest evicted.
  sect("2. eviction — 600 writes leave exactly 500 drawers");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    for (let i = 0; i < 600; i++) {
      await writeTurn(
        channel,
        "Author" + i,
        "msg " + i,
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      );
    }
    const transcriptDrawers = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === channel,
    );
    check(
      `exactly ${CHANNEL_TRANSCRIPT_CAP} transcript drawers remain`,
      transcriptDrawers.length === CHANNEL_TRANSCRIPT_CAP,
      `actual=${transcriptDrawers.length}`,
    );
    // The first 100 messages must have been evicted; the newest 500 remain.
    const first = transcriptDrawers[0]?.content ?? "";
    const last =
      transcriptDrawers[transcriptDrawers.length - 1]?.content ?? "";
    check("oldest remaining drawer is msg 100", first.includes("msg 100"));
    check("newest remaining drawer is msg 599", last.includes("msg 599"));
    _resetBackendForTesting();
  }

  // 3. Layer B fact rooms are NOT subject to the cap.
  sect("3. eviction — Layer B fact rooms unaffected");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    // Pre-populate Layer B drawers (different wings/rooms — these belong to
    // qwen-internal facts, not the conversation transcript). They MUST survive.
    const factRooms = [
      "decision",
      "naming",
      "user_preference",
      "canon_observation",
    ];
    for (const room of factRooms) {
      for (let i = 0; i < 3; i++) {
        backend.drawers.push({
          id: `fact-${room}-${i}`,
          wing: "qwen",
          room,
          content: `[fact] ${room} ${i}`,
          created_at: new Date().toISOString(),
        });
      }
    }
    const factDrawerIds = new Set(
      backend.drawers
        .filter((d) => d.wing === "qwen")
        .map((d) => d.id),
    );
    // Now write 500 transcript drawers up to the cap.
    for (let i = 0; i < 500; i++) {
      await writeTurn(
        channel,
        "Author",
        "transcript " + i,
        new Date(Date.UTC(2026, 0, 1, 1, 0, i)).toISOString(),
      );
    }
    // ...and one more, which should evict the OLDEST transcript only.
    await writeTurn(
      channel,
      "Author",
      "transcript 500",
      new Date(Date.UTC(2026, 0, 1, 1, 30, 0)).toISOString(),
    );
    const remainingFacts = backend.drawers.filter((d) =>
      factDrawerIds.has(d.id),
    );
    const remainingTranscripts = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === channel,
    );
    check(
      `all ${factRooms.length * 3} Layer B fact drawers preserved`,
      remainingFacts.length === factRooms.length * 3,
      `actual=${remainingFacts.length}`,
    );
    check(
      `exactly ${CHANNEL_TRANSCRIPT_CAP} transcript drawers remain`,
      remainingTranscripts.length === CHANNEL_TRANSCRIPT_CAP,
      `actual=${remainingTranscripts.length}`,
    );
    _resetBackendForTesting();
  }

  // 4. Per-channel scope: writes to channel A do not evict channel B.
  sect("4. eviction — per-channel scope");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    // 100 messages in channel B
    for (let i = 0; i < 100; i++) {
      await writeTurn(
        otherChannel,
        "B",
        "B msg " + i,
        new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      );
    }
    // 600 messages in channel A → only A is capped
    for (let i = 0; i < 600; i++) {
      await writeTurn(
        channel,
        "A",
        "A msg " + i,
        new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
      );
    }
    const aCount = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === channel,
    ).length;
    const bCount = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === otherChannel,
    ).length;
    check(`channel A capped at ${CHANNEL_TRANSCRIPT_CAP}`, aCount === CHANNEL_TRANSCRIPT_CAP);
    check("channel B untouched (100 drawers)", bCount === 100);
    _resetBackendForTesting();
  }

  // 5. readVerbatimWindow returns most-recent K, oldest-to-newest, excluding author.
  sect("5. readVerbatimWindow — ordering + exclusion");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    // Alternate authors so exclusion is observable.
    const authors = ["Alice", "Bob", "Alice", "Carol", "Bob", "Alice", "Carol"];
    for (let i = 0; i < authors.length; i++) {
      await writeTurn(
        channel,
        authors[i]!,
        `m${i}`,
        new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString(),
      );
    }
    // Read most recent 3 excluding Alice.
    const window = await readVerbatimWindow(channel, "Alice", 3);
    check("returned 3 entries", window.length === 3);
    // Non-Alice messages in chronological order: m1 (Bob), m3 (Carol),
    // m4 (Bob), m6 (Carol). Most-recent 3 of those are m3, m4, m6.
    check(
      "no Alice entries",
      window.every((e: TranscriptEntry) => e.author !== "Alice"),
    );
    check(
      "ordered oldest-to-newest by timestamp",
      window.every(
        (e, i) =>
          i === 0 ||
          new Date(e.timestamp).getTime() >=
            new Date(window[i - 1]!.timestamp).getTime(),
      ),
    );
    check("first entry is oldest of newest-3 non-Alice (m3)", window[0]?.text === "m3");
    check("middle entry is m4", window[1]?.text === "m4");
    check("last entry is newest non-Alice (m6)", window[2]?.text === "m6");
    _resetBackendForTesting();
  }

  // 6. searchProse passes wing="conversation" and channel scope to the backend.
  sect("6. searchProse — wing scope + optional channel");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    await writeTurn(channel, "Alice", "the quick brown fox", "2026-03-01T00:00:00Z");
    await writeTurn(channel, "Bob", "lazy dog jumps", "2026-03-01T00:01:00Z");
    await writeTurn(otherChannel, "Carol", "quick rabbit", "2026-03-01T00:02:00Z");

    // Without channel scope: search the whole conversation wing.
    const all = await searchProse("quick", undefined, 5);
    const lastSearch = backend.searchSpy[backend.searchSpy.length - 1]!;
    check("search wing is 'conversation'", lastSearch.wing === CHANNEL_TRANSCRIPT_WING);
    check("search room undefined when channelId omitted", lastSearch.room === undefined);
    check("returned 2 'quick' matches across both channels", all.length === 2);

    // With channel scope: only this channel's matches.
    const scoped = await searchProse("quick", channel, 5);
    const scopedSearch = backend.searchSpy[backend.searchSpy.length - 1]!;
    check("search room equals channelId when provided", scopedSearch.room === channel);
    check("returned 1 'quick' match scoped to channel", scoped.length === 1);
    check("scoped result is from correct channel", scoped[0]?.channelId === channel);
    _resetBackendForTesting();
  }

  // 7. MEMPALACE_ENABLED=false → all calls are no-ops.
  sect("7. flag-gated — no-op when MEMPALACE_ENABLED=false");
  {
    process.env.MEMPALACE_ENABLED = "false";
    const backend = makeBackend();
    _setBackendForTesting(backend);
    await writeTurn(channel, "X", "should not write", "2026-05-01T00:00:00Z");
    check("writeTurn did not call backend", backend.drawers.length === 0);
    const w = await readVerbatimWindow(channel, "Y", 5);
    check("readVerbatimWindow returns []", Array.isArray(w) && w.length === 0);
    const s = await searchProse("anything");
    check("searchProse returns []", Array.isArray(s) && s.length === 0);
    check("searchProse did not call backend.search", backend.searchSpy.length === 0);
    _resetBackendForTesting();
    // Restore for subsequent tests.
    process.env.MEMPALACE_ENABLED = "true";
  }

  // 8. Backend errors are swallowed — writeTurn never throws.
  sect("8. failure handling — backend errors swallowed");
  {
    _setBackendForTesting({
      async addDrawer() {
        throw new Error("backend exploded");
      },
      async listDrawers() {
        throw new Error("backend exploded");
      },
      async getDrawer() {
        throw new Error("backend exploded");
      },
      async deleteDrawer() {
        return false;
      },
      async search() {
        throw new Error("backend exploded");
      },
    });
    let writeThrew = false;
    try {
      await writeTurn(channel, "A", "t", "2026-05-01T00:00:00Z");
    } catch {
      writeThrew = true;
    }
    check("writeTurn does not throw on backend failure", !writeThrew);

    let readThrew = false;
    let readVal: TranscriptEntry[] = [{ author: "x", text: "x", timestamp: "x", channelId: "x" }];
    try {
      readVal = await readVerbatimWindow(channel, "Y", 5);
    } catch {
      readThrew = true;
    }
    check("readVerbatimWindow does not throw", !readThrew);
    check("readVerbatimWindow returns [] on failure", readVal.length === 0);

    let searchThrew = false;
    let searchVal: TranscriptEntry[] = [{ author: "x", text: "x", timestamp: "x", channelId: "x" }];
    try {
      searchVal = await searchProse("q", channel, 5);
    } catch {
      searchThrew = true;
    }
    check("searchProse does not throw", !searchThrew);
    check("searchProse returns [] on failure", searchVal.length === 0);
    _resetBackendForTesting();
  }

  // 9. transcribeIncoming dedupes on messageId across multiple BotInstances.
  sect("9. transcribeIncoming — dedupe on messageId");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    _resetSeenIncomingForTesting();
    // Two BotInstances in one process both call this for the same Discord
    // MessageCreate event — only one drawer must be written.
    await transcribeIncoming(
      channel,
      "msg-id-1",
      "User",
      "Hello there",
      "2026-06-01T00:00:00Z",
    );
    await transcribeIncoming(
      channel,
      "msg-id-1",
      "User",
      "Hello there",
      "2026-06-01T00:00:00Z",
    );
    await transcribeIncoming(
      channel,
      "msg-id-2",
      "User",
      "Another",
      "2026-06-01T00:01:00Z",
    );
    check(
      "exactly 2 drawers from 3 calls (one duplicate)",
      backend.drawers.length === 2,
      `actual=${backend.drawers.length}`,
    );
    _resetBackendForTesting();
    _resetSeenIncomingForTesting();
  }

  // 10. Outgoing-via-incoming dedupe: when the bot's own send and a sibling
  // BotInstance both transcribe the same Discord message id, only one
  // drawer is written. This is the architectural fix for duplicate
  // outbound captures (formerly transcribeOutgoing wrote unconditionally).
  sect("10. transcribeIncoming — outbound + sibling dedupe on shared id");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    _resetSeenIncomingForTesting();
    // Bot A's own captureOutgoing fires first.
    await transcribeIncoming(
      channel,
      "shared-msg-id",
      "ClaudeCode",
      "Done.",
      "2026-06-02T00:00:00Z",
    );
    // Sibling Bot B's handleMessage observes the same MessageCreate.
    await transcribeIncoming(
      channel,
      "shared-msg-id",
      "ClaudeCode",
      "Done.",
      "2026-06-02T00:00:00Z",
    );
    check(
      "exactly 1 drawer from 2 calls on the same Discord message id",
      backend.drawers.length === 1,
      `actual=${backend.drawers.length}`,
    );
    _resetBackendForTesting();
    _resetSeenIncomingForTesting();
  }

  // 11. Per-channel mutex: concurrent writeTurns to one channel must not
  // overlap their add+enforceCap critical sections, even when each call's
  // backend ops slow-pipe through `await`. Without serialisation the two
  // calls would interleave list+delete and the cap would drift.
  sect("11. mutex — concurrent writes to one channel are serialised");
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const recorded: string[] = [];
    const slowBackend: TranscriptBackend = {
      async addDrawer(_w, _r, content) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        recorded.push(`add:${content.match(/"text":"([^"]+)"/)?.[1] ?? "?"}`);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return { success: true, drawer_id: `id-${recorded.length}` };
      },
      async listDrawers() {
        recorded.push("list");
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        return [];
      },
    };
    _setBackendForTesting(slowBackend);
    await Promise.all([
      writeTurn(channel, "A", "first", "2026-07-01T00:00:00Z"),
      writeTurn(channel, "A", "second", "2026-07-01T00:00:01Z"),
      writeTurn(channel, "A", "third", "2026-07-01T00:00:02Z"),
    ]);
    check(
      "no two writeTurns held the backend concurrently",
      maxInFlight === 1,
      `maxInFlight=${maxInFlight}`,
    );
    check(
      "writes hit the backend in submission order",
      recorded.filter((s) => s.startsWith("add:")).join("|") ===
        "add:first|add:second|add:third",
      `recorded=${recorded.join(",")}`,
    );
    _resetBackendForTesting();
  }

  // 12. Preview truncation (Comment #2): when listDrawers' content_preview
  // is shorter than the full envelope, peekEnvelopeTs must still recover ts
  // from the prefix so enforceCap evicts the right drawers.
  sect("12. enforceCap — sorts correctly under preview truncation");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    // Manually populate CAP + 5 drawers, descending ts (so insertion order
    // is opposite of age order — the sort is doing real work). Each
    // drawer's content is the full envelope but artificially truncated to
    // 60 chars to simulate a server-side preview cap.
    const fullEnvelopes: { content: string; truncated: string; ts: string }[] = [];
    for (let i = 0; i < CHANNEL_TRANSCRIPT_CAP + 5; i++) {
      const ts = new Date(
        Date.UTC(2026, 0, 1, 0, 0, CHANNEL_TRANSCRIPT_CAP + 5 - i),
      ).toISOString();
      const fullText = "x".repeat(200);
      const env = JSON.stringify({ v: 1, ts, author: "A", text: fullText });
      const truncated = env.slice(0, 60);
      fullEnvelopes.push({ content: env, truncated, ts });
      backend.drawers.push({
        id: `pre-${i}`,
        wing: CHANNEL_TRANSCRIPT_WING,
        room: channel,
        content: truncated,
        created_at: new Date().toISOString(),
      });
    }
    // Trigger eviction via one more writeTurn.
    await writeTurn(
      channel,
      "A",
      "trigger",
      "2026-01-02T00:00:00.000Z",
    );
    const transcriptDrawers = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === channel,
    );
    check(
      `converges to CAP after one write under preview truncation`,
      transcriptDrawers.length === CHANNEL_TRANSCRIPT_CAP,
      `actual=${transcriptDrawers.length}`,
    );
    // Oldest 5 (highest indices in fullEnvelopes — those had the smallest
    // ts because we built ts in reverse) plus the new "trigger" drawer
    // should determine survivors.
    const survivedIds = new Set(transcriptDrawers.map((d) => d.id));
    check(
      "the trigger drawer survives",
      survivedIds.size > 0 &&
        backend.drawers.some(
          (d) => d.content.includes('"text":"trigger"') && survivedIds.has(d.id),
        ),
    );
    _resetBackendForTesting();
  }

  // 13. Backlog convergence (Comment #3): if the channel starts above
  // CAP + 1, one writeTurn should catch us up — not drift one drawer per
  // write.
  sect("13. enforceCap — converges from a >CAP+1 backlog in one write");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    // Pre-populate 600 valid envelope drawers (CAP + 100).
    for (let i = 0; i < CHANNEL_TRANSCRIPT_CAP + 100; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      backend.drawers.push({
        id: `back-${i}`,
        wing: CHANNEL_TRANSCRIPT_WING,
        room: channel,
        content: JSON.stringify({ v: 1, ts, author: "A", text: "msg " + i }),
        created_at: ts,
      });
    }
    await writeTurn(
      channel,
      "A",
      "trigger",
      "2026-01-02T00:00:00.000Z",
    );
    const remaining = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === channel,
    );
    check(
      `single write converges 600+1 → ${CHANNEL_TRANSCRIPT_CAP}`,
      remaining.length === CHANNEL_TRANSCRIPT_CAP,
      `actual=${remaining.length}`,
    );
    _resetBackendForTesting();
  }

  // 14. NaN-safe sort (Comment #4): a drawer with a malformed ts must not
  // poison the sort or cause the read path to throw.
  sect("14. malformed ts — sort is NaN-safe and reads still work");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    backend.drawers.push({
      id: "bad-ts-1",
      wing: CHANNEL_TRANSCRIPT_WING,
      room: channel,
      content: JSON.stringify({
        v: 1,
        ts: "not-a-real-date",
        author: "A",
        text: "garbage ts",
      }),
      created_at: new Date().toISOString(),
    });
    backend.drawers.push({
      id: "good-ts-1",
      wing: CHANNEL_TRANSCRIPT_WING,
      room: channel,
      content: JSON.stringify({
        v: 1,
        ts: "2026-08-01T00:00:00.000Z",
        author: "A",
        text: "valid ts",
      }),
      created_at: new Date().toISOString(),
    });
    let threw = false;
    let entries: TranscriptEntry[] = [];
    try {
      entries = await readVerbatimWindow(channel, "Z", 5);
    } catch {
      threw = true;
    }
    check("readVerbatimWindow does not throw on malformed ts", !threw);
    check(
      "valid-ts entry surfaces in the window",
      entries.some((e) => e.text === "valid ts"),
    );
    _resetBackendForTesting();
  }

  // 15. JSON-safe author extraction (Comment B): an author name containing
  // an embedded quote (Discord allows display names with special chars
  // through nicknames) must be recovered correctly when the preview is
  // not truncated. Regex-only path would split on the inner quote.
  sect("15. readVerbatimWindow — JSON-safe author with embedded quote");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    backend.drawers.push({
      id: "quoted-author",
      wing: CHANNEL_TRANSCRIPT_WING,
      room: channel,
      content: JSON.stringify({
        v: 1,
        ts: "2026-09-01T00:00:00.000Z",
        author: 'name with "quote" inside',
        text: "hello",
      }),
      created_at: new Date().toISOString(),
    });
    const window = await readVerbatimWindow(channel, "ZZ", 5);
    check(
      "quoted-author entry surfaces with full author preserved",
      window.some((e) => e.author === 'name with "quote" inside'),
      `entries=${JSON.stringify(window)}`,
    );
    // Author exclusion using the exact JSON-decoded string also works.
    const excluded = await readVerbatimWindow(
      channel,
      'name with "quote" inside',
      5,
    );
    check(
      "exclude-by-author matches against JSON-decoded author",
      excluded.length === 0,
    );
    _resetBackendForTesting();
  }

  // 16. channelLocks cleanup (Comment C): after the queued work for a
  // channel settles and no later writer chained on top, the lock entry is
  // removed. Otherwise the Map would grow unbounded with channel turnover.
  sect("16. channelLocks — entry removed after settle (no-tail case)");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    const ephemeralChannel = "5555000000";
    await writeTurn(
      ephemeralChannel,
      "X",
      "one and done",
      "2026-09-02T00:00:00Z",
    );
    // settled.finally fires asynchronously — yield once so the cleanup
    // microtask runs.
    await new Promise((res) => setImmediate(res));
    // The Map is module-private; we observe its size indirectly by
    // checking that subsequent writes still work and that a second write
    // to the same channel doesn't see a stale entry.
    await writeTurn(
      ephemeralChannel,
      "X",
      "two",
      "2026-09-02T00:00:01Z",
    );
    await new Promise((res) => setImmediate(res));
    check(
      "two writes to one ephemeral channel both wrote drawers",
      backend.drawers.filter(
        (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === ephemeralChannel,
      ).length === 2,
    );
    _resetBackendForTesting();
  }

  // 17. enforceCap pages until convergence (Comment D): a backlog larger
  // than CAP*2+1 takes more than one list iteration but converges.
  sect("17. enforceCap — pages backlog > CAP*2+1 across iterations");
  {
    const backend = makeBackend();
    _setBackendForTesting(backend);
    // CAP = 500. Pre-populate 1500 (> CAP*2+1 = 1001) valid envelope drawers.
    const TOTAL = CHANNEL_TRANSCRIPT_CAP * 3;
    for (let i = 0; i < TOTAL; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      backend.drawers.push({
        id: `huge-${i}`,
        wing: CHANNEL_TRANSCRIPT_WING,
        room: channel,
        content: JSON.stringify({ v: 1, ts, author: "A", text: "msg " + i }),
        created_at: ts,
      });
    }
    await writeTurn(
      channel,
      "A",
      "trigger",
      "2026-01-02T00:00:00.000Z",
    );
    const remaining = backend.drawers.filter(
      (d) => d.wing === CHANNEL_TRANSCRIPT_WING && d.room === channel,
    );
    check(
      `paged loop converges ${TOTAL}+1 → ${CHANNEL_TRANSCRIPT_CAP}`,
      remaining.length === CHANNEL_TRANSCRIPT_CAP,
      `actual=${remaining.length}`,
    );
    _resetBackendForTesting();
  }

  // 18. enforceCap surfaces deleteDrawer-returns-false (Comment E): the
  // default mempalace client returns false on soft delete failure without
  // throwing. enforceCap must log those and stop spinning when no progress
  // is being made (otherwise it loops up to MAX_ITERATIONS).
  sect("18. enforceCap — handles deleteDrawer returning false");
  {
    let listCalls = 0;
    let deleteCalls = 0;
    const errors: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    const capture = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    console.error = capture;
    console.warn = capture;
    try {
      // Fill ≥ LIST_LIMIT (CAP*2+1 = 1001) so the "got the full set" early
      // exit doesn't fire and we reach the no-progress check.
      const STUCK_COUNT = CHANNEL_TRANSCRIPT_CAP * 2 + 1;
      const stuckDrawers = Array.from({ length: STUCK_COUNT }, (_, i) => {
        const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        return {
          id: `stuck-${i}`,
          text: JSON.stringify({ v: 1, ts, author: "A", text: "x" }),
          wing: CHANNEL_TRANSCRIPT_WING,
          room: channel,
        };
      });
      _setBackendForTesting({
        async addDrawer() {
          return { success: true, drawer_id: "added-1" };
        },
        async listDrawers() {
          listCalls++;
          return stuckDrawers;
        },
        async getDrawer() {
          return null;
        },
        async deleteDrawer() {
          deleteCalls++;
          return false;
        },
        async search() {
          return [];
        },
      });
      await writeTurn(channel, "A", "x", "2026-01-01T00:00:00.000Z");
    } finally {
      console.error = origError;
      console.warn = origWarn;
      _resetBackendForTesting();
    }
    const overflow = CHANNEL_TRANSCRIPT_CAP * 2 + 1 - CHANNEL_TRANSCRIPT_CAP;
    check(
      "enforceCap stopped after no-progress iteration (single list pass)",
      listCalls === 1,
      `listCalls=${listCalls}`,
    );
    check(
      "enforceCap attempted every overflow delete in the iter",
      deleteCalls === overflow,
      `deleteCalls=${deleteCalls} expected=${overflow}`,
    );
    check(
      "every false-return surfaced via console.error",
      errors.filter((e) => e.includes("returned false")).length === overflow,
      `falseErrors=${errors.filter((e) => e.includes("returned false")).length}`,
    );
    check(
      "no-progress warning was logged",
      errors.some((e) => e.includes("made no progress")),
    );
  }

  // 19. transcribeIncoming respects MEMPALACE_ENABLED before mutating the
  // dedupe LRU (Comment I). An id observed while disabled must remain
  // eligible once MemPalace comes back online.
  sect("19. transcribeIncoming — flag-gated before markSeen mutation");
  {
    process.env.MEMPALACE_ENABLED = "false";
    _resetSeenIncomingForTesting();
    const backend = makeBackend();
    _setBackendForTesting(backend);
    await transcribeIncoming(
      channel,
      "rotates-id",
      "U",
      "first observation",
      "2026-09-03T00:00:00Z",
    );
    check(
      "no drawer written while disabled",
      backend.drawers.length === 0,
    );
    process.env.MEMPALACE_ENABLED = "true";
    await transcribeIncoming(
      channel,
      "rotates-id",
      "U",
      "later observation",
      "2026-09-03T00:00:01Z",
    );
    check(
      "after re-enable, the same id was captured (LRU not mutated while disabled)",
      backend.drawers.length === 1,
      `actual=${backend.drawers.length}`,
    );
    _resetBackendForTesting();
    _resetSeenIncomingForTesting();
  }

  // 20. Memory-offline warning: failed mpAddDrawer (writeTurn) on a watched
  // channel posts the warning ONCE. Subsequent failures while still offline
  // do not re-fire. After a successful call, the flag clears so a fresh
  // outage re-fires the warning.
  sect("20. memory-offline warning — fires once per outage on writeTurn failure");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    const notifications: { channelId: string; message: string }[] = [];
    setMemoryOfflineNotifier((channelId, message) => {
      notifications.push({ channelId, message });
    });
    let mode: "fail" | "ok" = "fail";
    const flippy: TranscriptBackend = {
      async addDrawer() {
        if (mode === "fail") return { success: false, error: "boom" };
        return { success: true, drawer_id: "ok-1" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        if (mode === "fail") {
          throw new Error("network unreachable");
        }
        return [];
      },
    };
    _setBackendForTesting(flippy);

    // First failure → notification fires.
    await writeTurn(channel, "A", "first", "2026-10-01T00:00:00Z");
    check(
      "first failure posted exactly one notification",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );
    check(
      "notification carries the canonical warning text",
      notifications[0]?.message === MEMORY_OFFLINE_WARNING,
      `actual=${notifications[0]?.message ?? "<none>"}`,
    );
    check(
      "notification is scoped to the failing channel",
      notifications[0]?.channelId === channel,
    );

    // Second failure → flag is set, no second notification.
    await writeTurn(channel, "A", "second", "2026-10-01T00:00:01Z");
    check(
      "second failure does NOT post a duplicate notification",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );

    // Recovery → flag clears.
    mode = "ok";
    await writeTurn(channel, "A", "recovered", "2026-10-01T00:00:02Z");
    check(
      "successful call did not post a notification",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );

    // Fresh outage → notification re-fires.
    mode = "fail";
    await writeTurn(channel, "A", "outage 2", "2026-10-01T00:00:03Z");
    check(
      "subsequent outage re-fires the notification once",
      notifications.length === 2,
      `actual=${notifications.length}`,
    );

    setMemoryOfflineNotifier(null);
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  // 21. Memory-offline warning — searchProse failure on a channel-scoped call
  // also fires the warning. Empty success (no results, but call succeeded)
  // does NOT fire.
  sect("21. memory-offline warning — searchProse: failure fires, empty success silent");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    const notifications: { channelId: string; message: string }[] = [];
    setMemoryOfflineNotifier((channelId, message) => {
      notifications.push({ channelId, message });
    });
    // Empty-success case first: backend returns [] without throwing — no warning.
    _setBackendForTesting({
      async addDrawer() {
        return { success: true, drawer_id: "x" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        return [];
      },
    });
    const empty = await searchProse("nothing matches", channel);
    check(
      "empty-success search returned []",
      Array.isArray(empty) && empty.length === 0,
    );
    check(
      "empty-success search did NOT fire warning",
      notifications.length === 0,
      `actual=${notifications.length}`,
    );

    // Failure case: backend throws — warning fires once.
    _setBackendForTesting({
      async addDrawer() {
        return { success: true, drawer_id: "x" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const failed = await searchProse("anything", channel);
    check(
      "failed search returned []",
      Array.isArray(failed) && failed.length === 0,
    );
    check(
      "failed search fired warning once",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );
    check(
      "warning message matches canonical text",
      notifications[0]?.message === MEMORY_OFFLINE_WARNING,
    );

    // Repeated failure on the same channel — still suppressed.
    await searchProse("again", channel);
    check(
      "repeated failure on same channel suppressed",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );

    setMemoryOfflineNotifier(null);
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  // 22. Memory-offline warning — per-channel scoping. Channel A's outage does
  // not suppress channel B's first-failure warning.
  sect("22. memory-offline warning — per-channel scope");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    const notifications: { channelId: string; message: string }[] = [];
    setMemoryOfflineNotifier((channelId, message) => {
      notifications.push({ channelId, message });
    });
    _setBackendForTesting({
      async addDrawer() {
        return { success: false, error: "down" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        throw new Error("down");
      },
    });
    await writeTurn(channel, "A", "msg-A", "2026-11-01T00:00:00Z");
    await writeTurn(otherChannel, "B", "msg-B", "2026-11-01T00:00:01Z");
    check(
      "two distinct channels produced two notifications",
      notifications.length === 2,
      `actual=${notifications.length}`,
    );
    const seenChannels = new Set(notifications.map((n) => n.channelId));
    check(
      "notifications are per-channel",
      seenChannels.has(channel) && seenChannels.has(otherChannel),
    );
    setMemoryOfflineNotifier(null);
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  // 23. Memory-offline warning — notifier callback errors do not break the
  // bot's reply path (writeTurn must still resolve). Defensive coding for
  // the Discord poster failing.
  sect("23. memory-offline warning — notifier errors swallowed");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    setMemoryOfflineNotifier(() => {
      throw new Error("notifier blew up");
    });
    _setBackendForTesting({
      async addDrawer() {
        return { success: false, error: "down" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        return [];
      },
    });
    let threw = false;
    try {
      await writeTurn(channel, "A", "x", "2026-12-01T00:00:00Z");
    } catch {
      threw = true;
    }
    check("writeTurn does not throw when notifier throws", !threw);
    setMemoryOfflineNotifier(null);
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  // 24. Memory-offline warning — backend that throws connection-style errors
  // simulates the outage path (the real-client + unreachable-URL scenario is
  // exercised in scripts/test-mempalace-warning.ts which spawns a fresh tsx
  // process with MEMPALACE_URL set to a black-hole address before module
  // load — the URL must be captured at import time, so it can't be flipped
  // mid-run inside this script).
  sect("24. memory-offline warning — connection-style throw simulates outage");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    const notifications: { channelId: string; message: string }[] = [];
    setMemoryOfflineNotifier((channelId, message) => {
      notifications.push({ channelId, message });
    });

    // Backend that throws the same shape mempalace-client throws when the
    // URL is unreachable: AbortError or fetch failed, surfaced through
    // mpSearchResult's tagged variant.
    let outage = true;
    _setBackendForTesting({
      async addDrawer() {
        if (outage) {
          throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:1");
        }
        return { success: true, drawer_id: "ok" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        if (outage) {
          throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:1");
        }
        return [];
      },
    });

    const outageChannel = "outage-channel";
    await writeTurn(outageChannel, "A", "first", "2027-01-01T00:00:00Z");
    check(
      "outage: first failure posts warning",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );
    await writeTurn(outageChannel, "A", "second", "2027-01-01T00:00:01Z");
    check(
      "outage: second failure suppressed",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );
    // Recovery: clear flag, no warning on success.
    outage = false;
    await writeTurn(outageChannel, "A", "recovered", "2027-01-01T00:00:02Z");
    check(
      "recovery: success does not post a notification",
      notifications.length === 1,
      `actual=${notifications.length}`,
    );
    // Fresh outage: re-fires once.
    outage = true;
    await writeTurn(outageChannel, "A", "outage 2", "2027-01-01T00:00:03Z");
    check(
      "fresh outage re-fires the warning once",
      notifications.length === 2,
      `actual=${notifications.length}`,
    );

    setMemoryOfflineNotifier(null);
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  // 25. Memory-offline warning — global searchProse (no channelId) does NOT
  // touch the per-channel offline state. There's no channel to attribute the
  // failure to, and global searches shouldn't accidentally clear another
  // channel's outage flag.
  sect("25. memory-offline warning — searchProse without channelId is silent");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    const notifications: { channelId: string; message: string }[] = [];
    setMemoryOfflineNotifier((channelId, message) => {
      notifications.push({ channelId, message });
    });
    _setBackendForTesting({
      async addDrawer() {
        return { success: true, drawer_id: "x" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        throw new Error("global search down");
      },
    });
    // Failed search WITHOUT channelId — should NOT fire warning.
    const r = await searchProse("anything"); // no channelId
    check("global search returned []", Array.isArray(r) && r.length === 0);
    check(
      "global search failure did NOT fire warning",
      notifications.length === 0,
      `actual=${notifications.length}`,
    );
    setMemoryOfflineNotifier(null);
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  // 26. Memory-offline warning — setMemoryOfflineNotifier(null) clears the
  // notifier; subsequent failures log but do not invoke any callback.
  sect("26. memory-offline warning — setMemoryOfflineNotifier(null) disables");
  {
    process.env.MEMPALACE_ENABLED = "true";
    _resetMemoryOfflineStateForTesting();
    let invoked = 0;
    setMemoryOfflineNotifier(() => {
      invoked++;
    });
    setMemoryOfflineNotifier(null);
    _setBackendForTesting({
      async addDrawer() {
        return { success: false, error: "down" };
      },
      async listDrawers() {
        return [];
      },
      async getDrawer() {
        return null;
      },
      async deleteDrawer() {
        return true;
      },
      async search() {
        return [];
      },
    });
    await writeTurn(channel, "A", "x", "2026-12-15T00:00:00Z");
    check(
      "after setMemoryOfflineNotifier(null), prior callback not invoked",
      invoked === 0,
      `invoked=${invoked}`,
    );
    _resetMemoryOfflineStateForTesting();
    _resetBackendForTesting();
  }

  console.log(`\n======\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
