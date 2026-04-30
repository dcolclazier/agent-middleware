/**
 * Embedded vector memory for the Qwen harness.
 *
 * Storage: better-sqlite3 + sqlite-vec (truly in-process, no sidecar).
 * Embeddings: POST http://localhost:3001/embed — reuses the SPARK/rag/
 *   all-MiniLM-L6-v2 model so Node never loads a second copy.
 *
 * If sqlite-vec fails to load (missing native binary on this host), the
 * module logs the error and makes remember()/recall() no-ops. The harness
 * must never crash just because vector memory is unavailable.
 */
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DB_PATH =
  process.env.QWEN_MEMORY_DB ??
  "/mnt/c/dev/agent-middleware/qwen-memory.db";
const RAG_EMBED_URL =
  process.env.RAG_EMBED_URL ?? "http://localhost:3001/embed";
const EMBED_DIM = 384;

type BetterSqliteDatabase = {
  prepare: (sql: string) => {
    run: (...params: any[]) => any;
    all: (...params: any[]) => any[];
    get: (...params: any[]) => any;
  };
  exec: (sql: string) => void;
  close: () => void;
};

let _db: BetterSqliteDatabase | null = null;
let _vecAvailable = false;
let _loadAttempted = false;
let _loadError: string | null = null;

async function loadDbLazy(): Promise<BetterSqliteDatabase | null> {
  if (_loadAttempted) return _db;
  _loadAttempted = true;
  try {
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(DB_PATH) as unknown as BetterSqliteDatabase;
    // sqlite-vec load() takes the raw sqlite db handle
    (sqliteVec as any).load(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        fact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Add explicit vec_rowid FK column so recall() can JOIN on a stable key
    // rather than relying on implicit rowid alignment between two tables
    // (which silently breaks under VACUUM or manual rowid inserts). Idempotent:
    // try the ALTER, swallow "duplicate column" errors on existing DBs.
    try {
      db.exec(`ALTER TABLE memory_meta ADD COLUMN vec_rowid INTEGER;`);
    } catch (e: any) {
      if (!/duplicate column/i.test(e?.message ?? "")) throw e;
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_meta_channel ON memory_meta(channel_id);`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_meta_vec_rowid ON memory_meta(vec_rowid);`,
    );
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding FLOAT[${EMBED_DIM}]);`,
    );

    _db = db;
    _vecAvailable = true;

    // Startup visibility: report current row counts so we can tell whether
    // memory has ever been written. Historically this reported 0 because the
    // BigInt rowid bug made every remember() a no-op.
    try {
      const metaCount = db
        .prepare(`SELECT count(*) AS n FROM memory_meta`)
        .get() as { n: number };
      const vecCount = db
        .prepare(`SELECT count(*) AS n FROM memory_vec`)
        .get() as { n: number };
      console.log(
        `[qwen-memory] DB ready: ${metaCount.n} meta rows, ${vecCount.n} vec rows`,
      );
    } catch {
      // Non-fatal — if we can't count, the writes will still work.
    }

    return db;
  } catch (err: any) {
    _loadError = err?.message ?? String(err);
    console.error(
      `[qwen-memory] sqlite-vec failed to load, vector memory disabled: ${_loadError}`,
    );
    _db = null;
    _vecAvailable = false;
    return null;
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  try {
    // Hard 3s timeout so a hanging RAG server can't wedge Qwen's channel
    // mutex. On timeout or any network error we return [] and the caller
    // treats that as "no vector available" → recall is empty, remember
    // is a silent no-op, harness keeps running.
    const res = await fetch(RAG_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      throw new Error(`embed HTTP ${res.status}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  } catch (err: any) {
    console.error(`[qwen-memory] embed() failed: ${err?.message ?? err}`);
    return [];
  }
}

function vecToBuffer(v: number[]): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    buf.writeFloatLE(v[i]!, i * 4);
  }
  return buf;
}

export async function remember(
  channelId: string,
  factType: string,
  content: string,
): Promise<void> {
  const db = await loadDbLazy();
  if (!db || !_vecAvailable) return;

  const trimmed = content.length > 4000 ? content.slice(0, 4000) : content;
  const [vec] = await embed([trimmed]);
  if (!vec || vec.length !== EMBED_DIM) {
    console.error(
      `[qwen-memory] skip remember: bad embedding (dim=${vec?.length ?? 0})`,
    );
    return;
  }

  try {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    const insertMeta = db.prepare(
      `INSERT INTO memory_meta (id, channel_id, fact_type, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const metaInfo = insertMeta.run(id, channelId, factType, trimmed, createdAt);

    // Let sqlite-vec auto-assign the vec0 rowid by omitting it from the
    // INSERT — we then back-link the returned rowid onto the meta row.
    // Why: the vec0 virtual table has strict C-level type checking on the
    // rowid column and rejects anything other than a pure SQLITE_INTEGER
    // binding. Passing JS Number (coerced from BigInt) or BigInt directly
    // from better-sqlite3 still produces the "Only integers are allows for
    // primary key values on memory_vec" error in practice. Omitting the
    // rowid and reading it back via lastInsertRowid dodges the binding
    // path entirely.
    const insertVec = db.prepare(
      `INSERT INTO memory_vec (embedding) VALUES (?)`,
    );
    const vecInfo = insertVec.run(vecToBuffer(vec));
    const vecRowid = Number((vecInfo as any).lastInsertRowid);
    if (!Number.isSafeInteger(vecRowid)) {
      throw new Error(
        `remember(): vec lastInsertRowid ${vecInfo?.lastInsertRowid} not a safe integer`,
      );
    }

    // Back-link the meta row to its vec rowid so recall() can JOIN on a
    // stable key (not the implicit sqlite rowid, which is fragile).
    db.prepare(`UPDATE memory_meta SET vec_rowid = ? WHERE id = ?`).run(
      vecRowid,
      id,
    );
  } catch (err: any) {
    console.error(`[qwen-memory] remember() insert failed: ${err?.message ?? err}`);
  }
}

export async function recall(
  channelId: string,
  query: string,
  topK: number,
  maxChars: number = 1500,
): Promise<string[]> {
  const db = await loadDbLazy();
  if (!db || !_vecAvailable) return [];

  const [qvec] = await embed([query]);
  if (!qvec || qvec.length !== EMBED_DIM) return [];

  try {
    // k must be baked into the WHERE clause for sqlite-vec MATCH queries.
    // Over-fetch (3x) and filter by channel_id in SQL, then slice to topK.
    // JOIN on memory_meta.vec_rowid (the explicit FK we set in remember)
    // rather than implicit rowid alignment — survives VACUUM/schema change.
    const overFetch = Math.max(topK * 4, 10);
    const sql = `
      SELECT m.content AS content, v.distance AS distance
      FROM memory_vec v
      JOIN memory_meta m ON m.vec_rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
        AND m.channel_id = ?
      ORDER BY v.distance ASC
      LIMIT ?
    `;
    const rows = db
      .prepare(sql)
      .all(vecToBuffer(qvec), overFetch, channelId, topK) as Array<{
      content: string;
      distance: number;
    }>;

    const out: string[] = [];
    let total = 0;
    for (const row of rows) {
      const cost = row.content.length + 4;
      if (total + cost > maxChars) break;
      out.push(row.content);
      total += cost;
    }
    return out;
  } catch (err: any) {
    console.error(`[qwen-memory] recall() query failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * A single row returned by `list()`. Includes similarity score iff the
 * list was driven by a query (semantic search mode).
 */
export interface MemoryRow {
  id: string;
  channel_id: string;
  fact_type: string;
  content: string;
  created_at: string;
  similarity?: number;
}

/**
 * List memory rows, either by recency (no query) or by semantic similarity
 * to the given query. Used by the `list_memory` Qwen tool so users can see
 * what the agent remembers before asking it to forget something.
 */
export async function list(
  channelId: string | undefined,
  query: string | undefined,
  topK: number = 10,
): Promise<MemoryRow[]> {
  const db = await loadDbLazy();
  if (!db || !_vecAvailable) return [];

  try {
    if (query && query.trim().length > 0) {
      const [qvec] = await embed([query]);
      if (!qvec || qvec.length !== EMBED_DIM) return [];
      const overFetch = Math.max(topK * 4, 10);
      const params: (Buffer | number | string)[] = [
        vecToBuffer(qvec),
        overFetch,
      ];
      let sql = `
        SELECT m.id AS id, m.channel_id AS channel_id, m.fact_type AS fact_type,
               m.content AS content, m.created_at AS created_at,
               v.distance AS distance
        FROM memory_vec v
        JOIN memory_meta m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
      `;
      if (channelId) {
        sql += ` AND m.channel_id = ?`;
        params.push(channelId);
      }
      sql += ` ORDER BY v.distance ASC LIMIT ?`;
      params.push(topK);

      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        channel_id: string;
        fact_type: string;
        content: string;
        created_at: string;
        distance: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        channel_id: r.channel_id,
        fact_type: r.fact_type,
        content: r.content,
        created_at: r.created_at,
        similarity: 1 / (1 + r.distance),
      }));
    }

    // Recency mode — no query, newest first.
    let sql = `
      SELECT id, channel_id, fact_type, content, created_at
      FROM memory_meta
    `;
    const params: (string | number)[] = [];
    if (channelId) {
      sql += ` WHERE channel_id = ?`;
      params.push(channelId);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(topK);
    return db.prepare(sql).all(...params) as MemoryRow[];
  } catch (err: any) {
    console.error(`[qwen-memory] list() failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Delete memory rows by their UUID id. Returns the number actually deleted.
 * Used by the `forget_memory` Qwen tool — caller is expected to have first
 * called `list()` to show the user what's about to be deleted.
 */
export async function forget(ids: string[]): Promise<number> {
  const db = await loadDbLazy();
  if (!db || !_vecAvailable) return 0;
  if (!Array.isArray(ids) || ids.length === 0) return 0;

  try {
    // Look up vec_rowids for these ids so we can delete from both tables.
    const placeholders = ids.map(() => "?").join(",");
    const lookup = db
      .prepare(
        `SELECT id, vec_rowid FROM memory_meta WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; vec_rowid: number | null }>;

    const vecRowids = lookup
      .map((r) => r.vec_rowid)
      .filter((x): x is number => typeof x === "number");

    // Transactional delete: vec rows first, then meta rows. Both use the
    // IN (?,...) pattern. Wrap in BEGIN/COMMIT via db.exec for atomicity.
    db.exec("BEGIN");
    try {
      if (vecRowids.length > 0) {
        const vecPlaceholders = vecRowids.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM memory_vec WHERE rowid IN (${vecPlaceholders})`,
        ).run(...vecRowids);
      }
      const delInfo = db
        .prepare(`DELETE FROM memory_meta WHERE id IN (${placeholders})`)
        .run(...ids);
      db.exec("COMMIT");
      return Number(delInfo.changes ?? lookup.length);
    } catch (inner) {
      db.exec("ROLLBACK");
      throw inner;
    }
  } catch (err: any) {
    console.error(`[qwen-memory] forget() failed: ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * Heuristic end-of-turn memory writer. Called by qwen-harness.ts after each
 * agent turn. Simple v1: write the last 3 user+assistant exchanges as raw
 * context if a canon commit just happened OR if we've accumulated 5+ turns.
 * No recursive LLM summarization — stays fast and deterministic.
 */
export async function maybeRemember(session: {
  channelId: string;
  messages: any[];
  hadCommitDuringThisTask?: boolean;
  lastRememberedAtCount?: number;
}): Promise<void> {
  try {
    if (!Array.isArray(session.messages) || session.messages.length === 0) return;

    const turnCount = session.messages.filter(
      (m) => m && (m.role === "user" || m.role === "assistant"),
    ).length;

    // Fire on task_complete-with-commit OR whenever we've accumulated 5+
    // new user/assistant messages since the last successful write. The
    // previous "turnCount % 5 === 0" check was brittle: it only fired on
    // exact multiples, so turns that moved through 5 in delta-2 increments
    // (very common — each round-trip adds 2 messages) silently skipped it.
    const since = session.lastRememberedAtCount ?? 0;
    const delta = turnCount - since;
    const shouldRemember =
      !!session.hadCommitDuringThisTask || delta >= 5;
    if (!shouldRemember) return;

    // Grab last 6 user+assistant messages (≈3 pairs)
    const relevant: any[] = [];
    for (let i = session.messages.length - 1; i >= 0 && relevant.length < 6; i--) {
      const m = session.messages[i];
      if (!m) continue;
      if (m.role === "user" || m.role === "assistant") {
        relevant.unshift(m);
      }
    }

    const parts: string[] = [];
    for (const m of relevant) {
      const content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? "");
      parts.push(`${m.role}: ${content}`);
    }
    const joined = parts.join("\n\n");
    const summary = joined.length > 800 ? joined.slice(0, 800) : joined;
    if (summary.trim().length === 0) return;

    await remember(session.channelId, "context", summary);
    // Record the snapshot so the delta-based gate only re-fires after
    // another 5 turns of user/assistant activity.
    session.lastRememberedAtCount = turnCount;
  } catch (err: any) {
    console.error(`[qwen-memory] maybeRemember() failed: ${err?.message ?? err}`);
  }
}
