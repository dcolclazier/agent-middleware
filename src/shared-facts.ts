/**
 * Shared facts store — cross-agent ground truth.
 *
 * All three agents (Qwen, ClaudeCode, NemoClaw) read from the same JSONL file
 * so naming/decisions stay consistent. File-locked with proper-lockfile for
 * concurrent writers.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export type FactSource = "qwen" | "claude" | "nemoclaw" | "user";
export type FactType = "naming" | "decision" | "user_preference" | "context";

export interface Fact {
  id: string;
  source: FactSource;
  type: FactType;
  content: string;
  ts: string;
}

const FACTS_DIR =
  process.env.AGENT_FACTS_DIR ||
  "/mnt/c/dev/dcc/SPARK/agent_facts";
const FACTS_PATH = path.join(FACTS_DIR, "facts.jsonl");
const MAX_CONTENT_CHARS = 500;

async function ensureFile(): Promise<void> {
  try {
    await fs.mkdir(FACTS_DIR, { recursive: true });
  } catch (err) {
    // ignore
  }
  // Idempotent file create: `open` with flag "a" creates the file if missing
  // but never truncates. Avoids the access→write race where two parallel
  // first-writers could both see the file missing and both writeFile("") —
  // the second clobbering any line the first appended.
  try {
    const handle = await fs.open(FACTS_PATH, "a");
    await handle.close();
  } catch (err) {
    // If open failed for some reason other than missing-file, surface it.
    console.error(`[shared-facts] ensureFile open failed: ${err}`);
  }
}

// --- mtime-invalidated cache ---
//
// facts.jsonl is read on every Qwen turn; parsing the whole file each time
// is fine at ~50 lines but scales badly. Cache the parsed array and
// invalidate on mtime change. The cache is per-process; writes through this
// module update the cache in-place, but external edits to the file (e.g.
// Claude or a human hand-editing it) are picked up on the next read.
let _cache: Fact[] | null = null;
let _cacheMtimeMs = 0;

export async function writeFact(
  fact: Omit<Fact, "id" | "ts"> & { content: string },
): Promise<Fact> {
  await ensureFile();

  const content =
    fact.content.length > MAX_CONTENT_CHARS
      ? fact.content.slice(0, MAX_CONTENT_CHARS)
      : fact.content;

  const full: Fact = {
    id: randomUUID(),
    source: fact.source,
    type: fact.type,
    content,
    ts: new Date().toISOString(),
  };

  // proper-lockfile needs the file to exist
  const release = await lockfile.lock(FACTS_PATH, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    stale: 5_000,
  });
  try {
    await fs.appendFile(FACTS_PATH, JSON.stringify(full) + "\n", "utf-8");
  } finally {
    await release();
  }
  invalidateCache();
  return full;
}

async function readAllFacts(): Promise<Fact[]> {
  try {
    await ensureFile();
    const stat = await fs.stat(FACTS_PATH);
    if (_cache && stat.mtimeMs === _cacheMtimeMs) {
      return _cache;
    }
    const raw = await fs.readFile(FACTS_PATH, "utf-8");
    const out: Fact[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.content === "string" &&
          typeof parsed.ts === "string" &&
          typeof parsed.source === "string" &&
          typeof parsed.type === "string"
        ) {
          out.push(parsed as Fact);
        }
      } catch {
        // skip corrupt line
      }
    }
    _cache = out;
    _cacheMtimeMs = stat.mtimeMs;
    return out;
  } catch {
    return [];
  }
}

/** Invalidate the in-process read cache. Called after any write. */
function invalidateCache(): void {
  _cache = null;
  _cacheMtimeMs = 0;
}

export async function readFacts(opts?: {
  types?: FactType[];
  limit?: number;
  maxChars?: number;
}): Promise<Fact[]> {
  const all = await readAllFacts();
  let filtered = all;
  if (opts?.types && opts.types.length > 0) {
    const allowed = new Set(opts.types);
    filtered = filtered.filter((f) => allowed.has(f.type));
  }
  // newest first
  filtered.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  if (opts?.limit !== undefined) {
    filtered = filtered.slice(0, opts.limit);
  }

  if (opts?.maxChars !== undefined) {
    const out: Fact[] = [];
    let total = 0;
    for (const f of filtered) {
      const cost = f.content.length + 32; // rough per-line overhead
      if (total + cost > opts.maxChars) break;
      out.push(f);
      total += cost;
    }
    filtered = out;
  }

  return filtered;
}

/**
 * Delete a fact by its id. Rewrites the entire file (cheap at current
 * scale — we're at tens of lines, not millions). File-locked with the
 * same retry strategy as writeFact. Returns true iff a row was removed.
 * Used by the `forget_fact` Qwen tool.
 *
 * WARNING: the facts store is SHARED across all agents — deleting a fact
 * here removes it for ClaudeCode, NemoClaw, and Qwen. Callers (specifically
 * Qwen's persona rules) must confirm with the user before invoking.
 */
export async function deleteFact(id: string): Promise<boolean> {
  if (typeof id !== "string" || id.length === 0) return false;
  await ensureFile();

  const release = await lockfile.lock(FACTS_PATH, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    stale: 5_000,
  });
  try {
    const raw = await fs.readFile(FACTS_PATH, "utf-8");
    const kept: string[] = [];
    let removed = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.id === "string" && parsed.id === id) {
          removed = true;
          continue;
        }
      } catch {
        // Keep unparseable lines as-is so we don't silently lose data.
      }
      kept.push(trimmed);
    }
    if (!removed) return false;
    // Atomic: write to .tmp then rename. proper-lockfile guards against
    // concurrent rewrites; rename is atomic on posix.
    const tmpPath = FACTS_PATH + ".tmp";
    await fs.writeFile(
      tmpPath,
      kept.length > 0 ? kept.join("\n") + "\n" : "",
      "utf-8",
    );
    await fs.rename(tmpPath, FACTS_PATH);
  } finally {
    await release();
  }
  invalidateCache();
  return true;
}

/**
 * Returns a preformatted string ready to drop into a system prompt.
 * Newest first, capped by maxChars (default 1500).
 */
export async function readFactsAsString(maxChars: number = 1500): Promise<string> {
  const facts = await readFacts({ maxChars });
  if (facts.length === 0) return "";
  const lines: string[] = [];
  for (const f of facts) {
    lines.push(`[${f.source}/${f.type}] ${f.content}`);
  }
  return lines.join("\n");
}
