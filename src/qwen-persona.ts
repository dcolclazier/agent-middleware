/**
 * Persona loader for the Qwen harness.
 *
 * Reads qwen-persona/{IDENTITY,SOUL,MEMORY}.md and caches them with an
 * mtime-invalidated TTL. Replaced the previous fs.watch-based hot reload
 * because fs.watch on individual files is unreliable on WSL/Windows when
 * editors use atomic rename (write-temp-then-rename) — the watcher silently
 * dies and later edits are never picked up.
 *
 * Strategy: check the youngest file's mtime at most once every TTL_MS. If
 * any file has changed since the cached copy, reload all three. Bounded
 * work per turn, immune to editor quirks, no background watchers to leak.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { estimateTokens } from "./token-estimate.js";

export interface Persona {
  identity: string;
  soul: string;
  memory: string;
}

// Persona sub-budget from ADR-0003. The combined identity + soul + memory
// tokens must not exceed this; loadPersona() throws on overrun so the
// middleware fails fast rather than serving silently inflated prompts.
export const PERSONA_TOKEN_BUDGET = 1500;

interface PersonaBudgetCheck {
  ok: boolean;
  total: number;
  breakdown: { identity: number; soul: number; memory: number };
}

function checkPersonaBudget(persona: Persona): PersonaBudgetCheck {
  const breakdown = {
    identity: estimateTokens(persona.identity),
    soul: estimateTokens(persona.soul),
    memory: estimateTokens(persona.memory),
  };
  const total = breakdown.identity + breakdown.soul + breakdown.memory;
  return { ok: total <= PERSONA_TOKEN_BUDGET, total, breakdown };
}

function formatBudgetError(c: PersonaBudgetCheck): string {
  // Format is part of the contract — see scripts/test-persona-budget.ts
  // and ADR-0003. Per-file breakdown is required so an operator can see
  // which file to trim without re-running token estimates by hand.
  return (
    `persona over budget: ${c.total} tokens, max ${PERSONA_TOKEN_BUDGET}. ` +
    `Trim SOUL.md/MEMORY.md/IDENTITY.md before retrying. ` +
    `Per-file breakdown: SOUL.md=${c.breakdown.soul}, ` +
    `MEMORY.md=${c.breakdown.memory}, IDENTITY.md=${c.breakdown.identity}.`
  );
}

const PERSONA_DIR =
  process.env.QWEN_PERSONA_DIR ??
  "/mnt/c/dev/agent-middleware/qwen-persona";

const FILES = {
  identity: "IDENTITY.md",
  soul: "SOUL.md",
  memory: "MEMORY.md",
} as const;

const TTL_MS = parseInt(process.env.QWEN_PERSONA_TTL_MS ?? "60000", 10);

let _cache: Persona | null = null;
let _cachedMtimes: Record<string, number> = {};
let _lastCheckAt = 0;

async function readFileOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[qwen-persona] failed to read ${p}: ${msg}`);
    return "";
  }
}

async function readAll(): Promise<{ persona: Persona; mtimes: Record<string, number> }> {
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, name]) => {
      const full = path.join(PERSONA_DIR, name);
      let content = "";
      let mtime = 0;
      try {
        const [c, st] = await Promise.all([
          fs.readFile(full, "utf-8"),
          fs.stat(full),
        ]);
        content = c;
        mtime = st.mtimeMs;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[qwen-persona] failed to read ${full}: ${msg}`);
      }
      return { key, name, content, mtime };
    }),
  );
  const persona = {
    identity: entries.find((e) => e.key === "identity")?.content ?? "",
    soul: entries.find((e) => e.key === "soul")?.content ?? "",
    memory: entries.find((e) => e.key === "memory")?.content ?? "",
  };
  const mtimes: Record<string, number> = {};
  for (const e of entries) mtimes[e.name] = e.mtime;
  return { persona, mtimes };
}

async function refreshIfStale(): Promise<void> {
  const now = Date.now();
  if (_cache && now - _lastCheckAt < TTL_MS) return; // still fresh

  // Cheap mtime check before re-reading file contents. Only read if any
  // mtime has changed since we last cached.
  if (_cache) {
    try {
      const stats = await Promise.all(
        Object.values(FILES).map((name) =>
          fs.stat(path.join(PERSONA_DIR, name)).catch(() => null),
        ),
      );
      let changed = false;
      for (const [i, name] of Object.values(FILES).entries()) {
        const mt = stats[i]?.mtimeMs ?? 0;
        if (mt !== (_cachedMtimes[name] ?? 0)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        _lastCheckAt = now;
        return;
      }
    } catch {
      // Fall through to full reload.
    }
  }

  const { persona, mtimes } = await readAll();
  const check = checkPersonaBudget(persona);
  if (!check.ok) {
    // Reload-over-budget is *not* fully fatal at runtime: ADR-0003 scopes
    // fail-fast to startup, and runQwenTurn's outer try/catch swallows the
    // throw and surfaces it as a user-facing harness error. We log with a
    // [FATAL persona] prefix so the supervisor's log scraper still flags
    // it for the operator to fix, and we deliberately do NOT bump
    // _lastCheckAt — leaving it stale so the next loadPersona() call
    // re-attempts the read and re-logs, rather than silently serving
    // stale persona for a TTL window after a broken edit.
    if (_cache !== null) {
      console.error(
        `[FATAL persona] over budget post-reload: ${check.total} tokens`,
      );
    }
    throw new Error(formatBudgetError(check));
  }
  _cache = persona;
  _cachedMtimes = mtimes;
  _lastCheckAt = now;
  console.log(`[qwen-persona] reloaded (${Object.keys(mtimes).length} files)`);
}

export async function loadPersona(): Promise<Persona> {
  await refreshIfStale();
  return _cache ?? { identity: "", soul: "", memory: "" };
}

export function getPersonaSync(): Persona {
  if (!_cache) {
    throw new Error(
      "qwen-persona: getPersonaSync() called before loadPersona()",
    );
  }
  return _cache;
}

// Test-only: reset module state. Smoke scripts call this between cases
// because _cache / _cachedMtimes / _lastCheckAt are module-level. Not exported
// from any production index — only used by scripts/test-persona-budget.ts.
export function _resetCacheForTesting(): void {
  _cache = null;
  _cachedMtimes = {};
  _lastCheckAt = 0;
}

// Test-only: drop the TTL freshness window so the next loadPersona() call
// re-runs the mtime check. Preserves _cache and _cachedMtimes — used to
// simulate a reload (vs. a first-load), which exercises a different code
// path on budget overrun.
export function _invalidateTtlForTesting(): void {
  _lastCheckAt = 0;
}
