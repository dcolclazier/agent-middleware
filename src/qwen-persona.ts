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

export interface Persona {
  identity: string;
  soul: string;
  memory: string;
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
  _lastCheckAt = now;

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
      if (!changed) return;
    } catch {
      // Fall through to full reload.
    }
  }

  const { persona, mtimes } = await readAll();
  _cache = persona;
  _cachedMtimes = mtimes;
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
