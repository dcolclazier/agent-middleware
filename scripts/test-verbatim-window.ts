// Smoke tests for the [CHANNEL CONVERSATION] verbatim-window block (Slice 6).
// Run: npx tsx scripts/test-verbatim-window.ts
//
// Drives buildSystemPrompt directly with a synthetic verbatimWindow argument
// (so we don't need a live MemPalace) and asserts the rendered prompt's
// shape, ordering, exclusion, trimming, and omit-when-empty behaviour. A
// separate end-to-end check exercises the channel-transcript module's
// readVerbatimWindow with an in-memory backend so the integration with that
// module's exclude semantics is covered without HTTP.

import {
  buildSystemPrompt,
  VERBATIM_WINDOW_BUDGET,
} from "../src/qwen-harness.js";
import {
  readVerbatimWindow,
  writeTurn,
  _setBackendForTesting,
  _resetBackendForTesting,
  type TranscriptBackend,
  type TranscriptEntry,
} from "../src/channel-transcript.js";
import { estimateTokens } from "../src/token-estimate.js";

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

const fakePersona = {
  identity: "test-identity",
  soul: "test-soul",
  memory: "test-memory",
};

const noTools: never[] = [];

function makeEntry(
  channelId: string,
  author: string,
  text: string,
  timestamp: string,
): TranscriptEntry {
  return { channelId, author, text, timestamp };
}

interface StoredDrawer {
  id: string;
  wing: string;
  room: string;
  content: string;
  created_at: string;
}

function makeBackend(): TranscriptBackend & { drawers: StoredDrawer[] } {
  const drawers: StoredDrawer[] = [];
  let counter = 0;
  return {
    drawers,
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
    async search() {
      return [];
    },
  };
}

async function main() {
  process.env.MEMPALACE_ENABLED = "true";

  // 1. Empty verbatim window omits the block entirely. The INSTRUCTIONS
  // block legitimately references the literal text [CHANNEL CONVERSATION]
  // (telling Qwen what the block IS), so we look for the block-header line
  // shape instead of the bare substring.
  sect("1. empty verbatimWindow → block omitted");
  {
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: [],
      facts: "",
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    // The actual block header is `[CHANNEL CONVERSATION]\n` at the start of
    // a section (preceded by a blank line). Scan for that shape.
    check(
      "no [CHANNEL CONVERSATION]\\n... block-header shape present",
      !/(^|\n\n)\[CHANNEL CONVERSATION\]\n/.test(prompt),
    );
  }

  // 2. Block format — header + one line per entry, oldest-to-newest.
  sect("2. block format — header + per-entry lines, oldest-first");
  {
    const channel = "test-channel";
    const entries: TranscriptEntry[] = [
      makeEntry(channel, "Alice", "first message", "2026-04-30T12:00:00Z"),
      makeEntry(channel, "Bob", "second message", "2026-04-30T12:00:01Z"),
      makeEntry(channel, "Carol", "third message", "2026-04-30T12:00:02Z"),
    ];
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: [],
      facts: "",
      channelState: "",
      tools: noTools,
      verbatimWindow: entries,
    });
    check(
      "[CHANNEL CONVERSATION] header is present",
      prompt.includes("[CHANNEL CONVERSATION]"),
    );
    const headerIdx = prompt.indexOf("[CHANNEL CONVERSATION]");
    check(
      "Alice's first line uses '<timestamp> <author>: <text>' shape",
      prompt.includes("2026-04-30T12:00:00Z Alice: first message"),
    );
    check(
      "Bob's line is rendered",
      prompt.includes("2026-04-30T12:00:01Z Bob: second message"),
    );
    check(
      "Carol's line is rendered",
      prompt.includes("2026-04-30T12:00:02Z Carol: third message"),
    );
    // Oldest-first ordering: Alice precedes Bob precedes Carol after the header.
    const aliceIdx = prompt.indexOf("Alice: first message");
    const bobIdx = prompt.indexOf("Bob: second message");
    const carolIdx = prompt.indexOf("Carol: third message");
    check(
      "entries appear in oldest-to-newest order",
      headerIdx < aliceIdx && aliceIdx < bobIdx && bobIdx < carolIdx,
      `header=${headerIdx} alice=${aliceIdx} bob=${bobIdx} carol=${carolIdx}`,
    );
  }

  // 3. Trimming — when 10 entries exceed VERBATIM_WINDOW_BUDGET, oldest are
  // dropped and the rendered block stays at-or-under the budget.
  sect("3. trimming — oldest dropped first to fit VERBATIM_WINDOW_BUDGET");
  {
    // Each entry: ~700 tokens of body. 10 entries ≈ 7 000 tokens — well over
    // the 2 500-token VERBATIM_WINDOW_BUDGET, so most must be dropped.
    const big = "x ".repeat(1500); // ~1500 chars ≈ ~430 tokens
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeEntry(
          "ch",
          `Author${i}`,
          `${big} #${i}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        ),
      );
    }
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: [],
      facts: "",
      channelState: "",
      tools: noTools,
      verbatimWindow: entries,
    });
    // Extract the [CHANNEL CONVERSATION] block — the section between the
    // header and the next blank line.
    const headerIdx = prompt.indexOf("[CHANNEL CONVERSATION]");
    check(
      "block is rendered (not entirely dropped)",
      headerIdx >= 0,
    );
    const after = prompt.slice(headerIdx);
    const blank = after.indexOf("\n\n");
    const block = blank >= 0 ? after.slice(0, blank) : after;
    const blockTokens = estimateTokens(block);
    check(
      `block tokens (${blockTokens}) ≤ VERBATIM_WINDOW_BUDGET (${VERBATIM_WINDOW_BUDGET})`,
      blockTokens <= VERBATIM_WINDOW_BUDGET,
    );
    // Oldest dropped first → Author0 must NOT survive when the window
    // overflows; the newest (Author9) must remain.
    check(
      "newest entry (Author9) is retained",
      block.includes("Author9"),
    );
    check(
      "oldest entry (Author0) is trimmed away",
      !block.includes("Author0:"),
    );
  }

  // 4. End-to-end via channel-transcript: 12 mixed-author drawers → block
  // contains exactly the 10 most recent non-Qwen entries, chronological.
  sect("4. integration — 12 mixed drawers, K=10, exclude self-author");
  {
    const channel = "ch-mixed";
    const selfAuthor = "Qwen";
    const backend = makeBackend();
    _setBackendForTesting(backend);

    // 12 messages alternating Alice / Qwen / Bob / Qwen / Alice / ... so the
    // window is forced to skip self-authored entries.
    const authors = [
      "Alice",
      "Qwen",
      "Bob",
      "Qwen",
      "Alice",
      "Bob",
      "Qwen",
      "Alice",
      "Bob",
      "Qwen",
      "Alice",
      "Bob",
    ];
    for (let i = 0; i < authors.length; i++) {
      await writeTurn(
        channel,
        authors[i]!,
        `msg-${i}-by-${authors[i]}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      );
    }

    const window = await readVerbatimWindow(channel, selfAuthor, 10);
    check(
      "readVerbatimWindow returned ≤ 10 entries",
      window.length <= 10,
      `got ${window.length}`,
    );
    check(
      "no self-authored (Qwen) entries leaked through",
      window.every((e) => e.author !== selfAuthor),
    );

    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: [],
      facts: "",
      channelState: "",
      tools: noTools,
      verbatimWindow: window,
    });
    check(
      "[CHANNEL CONVERSATION] header is present",
      prompt.includes("[CHANNEL CONVERSATION]"),
    );
    check(
      "Qwen self-author does not appear in the rendered block",
      !prompt.match(/\[CHANNEL CONVERSATION\][\s\S]*?Qwen:/),
    );

    // The 8 non-Qwen messages from the 12-message stream are: indices
    // 0,2,4,5,7,8,10,11 (Alice/Bob mix). All 8 fit in K=10, so all 8 must
    // appear, and chronological order must be preserved.
    const expectedIdxs = [0, 2, 4, 5, 7, 8, 10, 11];
    for (const i of expectedIdxs) {
      check(
        `non-self entry msg-${i}-by-${authors[i]} is rendered`,
        prompt.includes(`msg-${i}-by-${authors[i]}`),
      );
    }
    // Pairwise ordering check across the rendered block: msg-0 precedes
    // msg-2 precedes ... precedes msg-11.
    let prev = -1;
    let ordered = true;
    for (const i of expectedIdxs) {
      const at = prompt.indexOf(`msg-${i}-by-${authors[i]}`);
      if (at <= prev) ordered = false;
      prev = at;
    }
    check("non-self entries appear in chronological order", ordered);

    _resetBackendForTesting();
  }

  // 5. Fresh channel — readVerbatimWindow returns empty → block omitted.
  sect("5. fresh channel — empty window → block omitted");
  {
    const channel = "ch-fresh";
    const backend = makeBackend();
    _setBackendForTesting(backend);
    const window = await readVerbatimWindow(channel, "Qwen", 10);
    check("readVerbatimWindow returned []", window.length === 0);
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: [],
      facts: "",
      channelState: "",
      tools: noTools,
      verbatimWindow: window,
    });
    check(
      "no [CHANNEL CONVERSATION] block-header shape in rendered prompt",
      !/(^|\n\n)\[CHANNEL CONVERSATION\]\n/.test(prompt),
    );
    _resetBackendForTesting();
  }

  // 6. Existing system-prompt blocks are untouched by this slice.
  sect("6. existing blocks unchanged");
  {
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: ["recall-A"],
      facts: "fact-line",
      channelState: "current-task: x",
      tools: noTools,
      verbatimWindow: [],
    });
    check("[CHANNEL STATE] block still rendered", prompt.includes("[CHANNEL STATE]"));
    check("[SHARED FACTS] block still rendered", prompt.includes("[SHARED FACTS]"));
    check(
      "[RELEVANT MEMORIES] block still rendered",
      prompt.includes("[RELEVANT MEMORIES]"),
    );
  }

  // 7. INSTRUCTIONS block reflects the new verbatim-recall capability.
  sect("7. INSTRUCTIONS mentions [CHANNEL CONVERSATION]");
  {
    const prompt = buildSystemPrompt({
      persona: fakePersona,
      memories: [],
      facts: "",
      channelState: "",
      tools: noTools,
      verbatimWindow: [],
    });
    const inst = prompt.slice(prompt.indexOf("[INSTRUCTIONS]"));
    check(
      "INSTRUCTIONS references [CHANNEL CONVERSATION]",
      inst.includes("[CHANNEL CONVERSATION]"),
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("test-verbatim-window failed:", err);
  process.exit(1);
});
