// Smoke tests for persona startup-budget validation (slice #4).
// Run: npx tsx scripts/test-persona-budget.ts
//
// Verifies:
//   1. Below-budget persona loads cleanly (no observable change vs. previous behavior).
//   2. Over-budget persona throws with the contracted message format incl.
//      per-file token breakdown.
//   3. mtime-driven reload that pushes persona over budget logs
//      [FATAL persona] before throwing — so silently degraded prompts are
//      impossible.
//
// Test isolation: env-driven persona dir is set BEFORE the dynamic import so
// the module reads our temp dir. Each case writes fresh fixtures and calls
// _resetCacheForTesting() between runs.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "persona-budget-"));
process.env.QWEN_PERSONA_DIR = TEST_DIR;

// Dynamic import AFTER setting env, since qwen-persona.ts reads
// QWEN_PERSONA_DIR at module load time. Static `import` statements would
// hoist before our env mutation and we'd point at the production dir.
const { loadPersona, _resetCacheForTesting, _invalidateTtlForTesting } =
  await import("../src/qwen-persona.js");
const { estimateTokens } = await import("../src/token-estimate.js");

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

const LOREM_POOL = [
  "The resistance cell gathered at midnight. Kaelen surveyed the room.",
  "Consensus nodes flickered amber in the gloom. Two were corrupted.",
  "Marcus pulled the cipher deck and shuffled. Twenty-seven cards per hand.",
  "The handover protocol was failing in the shift districts. Loud failing.",
  "Old industrial machinery wheezed in the corner of the factory floor.",
  "Data fragments from the Archive Protocol bled across the network edges.",
  "She ran diagnostics on the quantum relay and swore under her breath.",
  "The goblin queen had grown restless. Her spies reported three incursions.",
];

// Build prose of approximately N tokens by appending lorem lines until
// estimateTokens crosses the threshold. Diverse content prevents BPE
// collapse — if we used "x".repeat(N), tiktoken encodes it as a tiny
// number of tokens and the test would lie.
function proseAroundTokens(target: number): string {
  let content = "";
  let i = 0;
  while (estimateTokens(content) < target) {
    content += `${LOREM_POOL[i % LOREM_POOL.length]} [frag ${i}] `;
    i++;
  }
  return content.trim();
}

function writeFixture(parts: { soul: string; memory: string; identity: string }) {
  fs.writeFileSync(path.join(TEST_DIR, "SOUL.md"), parts.soul);
  fs.writeFileSync(path.join(TEST_DIR, "MEMORY.md"), parts.memory);
  fs.writeFileSync(path.join(TEST_DIR, "IDENTITY.md"), parts.identity);
}

// ---------------------------------------------------------------------------
// T1 (tracer) — under-budget persona loads successfully
// ---------------------------------------------------------------------------
sect("T1: under-budget persona loads");
{
  writeFixture({
    soul: proseAroundTokens(400),
    memory: proseAroundTokens(400),
    identity: proseAroundTokens(400),
  });
  _resetCacheForTesting();
  try {
    const p = await loadPersona();
    check(
      "loadPersona returned non-empty Persona",
      p.soul.length > 0 && p.memory.length > 0 && p.identity.length > 0,
    );
    const total =
      estimateTokens(p.identity) +
      estimateTokens(p.soul) +
      estimateTokens(p.memory);
    check(
      `combined tokens (${total}) under 1500 budget`,
      total < 1500,
      `got ${total}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check("loadPersona did not throw on under-budget persona", false, msg);
  }
}

// ---------------------------------------------------------------------------
// T2 — over-budget persona throws with the contracted error format
// ---------------------------------------------------------------------------
sect("T2: over-budget persona throws with per-file breakdown");
{
  const overSoul = proseAroundTokens(700);
  const overMemory = proseAroundTokens(700);
  const overIdentity = proseAroundTokens(700);
  writeFixture({ soul: overSoul, memory: overMemory, identity: overIdentity });
  _resetCacheForTesting();
  let thrown: unknown = null;
  try {
    await loadPersona();
  } catch (err) {
    thrown = err;
  }
  check("loadPersona threw", thrown instanceof Error);
  if (thrown instanceof Error) {
    const msg = thrown.message;
    check(
      "error message starts with the contracted prefix",
      msg.startsWith("persona over budget: "),
      `got: ${msg.slice(0, 200)}`,
    );
    check(
      "error message includes 'max 1500'",
      /max 1500\b/.test(msg),
      `got: ${msg.slice(0, 200)}`,
    );
    check(
      "error message names all three persona files for trim guidance",
      /SOUL\.md/.test(msg) && /MEMORY\.md/.test(msg) && /IDENTITY\.md/.test(msg),
      `got: ${msg.slice(0, 200)}`,
    );
    check(
      "error message includes per-file token breakdown (numeric counts named per file)",
      /SOUL\.md[^\n]*\d/.test(msg) &&
        /MEMORY\.md[^\n]*\d/.test(msg) &&
        /IDENTITY\.md[^\n]*\d/.test(msg),
      `got: ${msg.slice(0, 400)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// T3 — mtime-driven reload that pushes persona over budget logs
//      [FATAL persona] before throwing
// ---------------------------------------------------------------------------
sect("T3: reload over budget logs [FATAL persona] then throws");
{
  // First load: under-budget — should succeed and populate _cache.
  writeFixture({
    soul: proseAroundTokens(400),
    memory: proseAroundTokens(400),
    identity: proseAroundTokens(400),
  });
  _resetCacheForTesting();
  let firstLoadOk = false;
  try {
    await loadPersona();
    firstLoadOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check("first load succeeded with under-budget fixture", false, msg);
  }

  if (firstLoadOk) {
    // Now bump the files past budget. fs.writeFileSync touches mtime.
    writeFixture({
      soul: proseAroundTokens(700),
      memory: proseAroundTokens(700),
      identity: proseAroundTokens(700),
    });

    // Drop the TTL freshness window so refreshIfStale re-runs the mtime
    // check on the next loadPersona() call. Preserves _cache so we exercise
    // the reload code path, not the first-load path.
    _invalidateTtlForTesting();

    // Capture console.error so we can assert the FATAL prefix is logged.
    const origError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };

    let thrown: unknown = null;
    try {
      await loadPersona();
    } catch (err) {
      thrown = err;
    } finally {
      console.error = origError;
    }

    check("reload threw on over-budget content", thrown instanceof Error);
    check(
      "console.error received a [FATAL persona] over budget post-reload line",
      captured.some((line) =>
        /\[FATAL persona\] over budget post-reload: \d+ tokens/.test(line),
      ),
      `captured lines: ${JSON.stringify(captured).slice(0, 300)}`,
    );
  }
}

// Cleanup
fs.rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
