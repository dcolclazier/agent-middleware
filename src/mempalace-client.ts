/**
 * mempalace-client.ts
 *
 * HTTP client for the MemPalace API server on Spark #2.
 * Replaces qwen-memory.ts (per-channel vector recall) and shared-facts.ts
 * (cross-agent facts) when MEMPALACE_ENABLED=true.
 *
 * All calls are simple fetch() with timeout — no MCP, no child processes.
 */

const MEMPALACE_URL =
  process.env.MEMPALACE_URL ?? "http://192.168.1.8:8100";
const MEMPALACE_TOKEN = process.env.MEMPALACE_TOKEN ?? "";
const TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  text: string;
  wing: string;
  room: string;
  similarity: number;
  distance: number;
  source_file?: string;
  created_at?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_before_filter: number;
}

export interface DrawerResult {
  success: boolean;
  drawer_id?: string;
  wing?: string;
  room?: string;
  error?: string;
}

export interface KgTriple {
  direction: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  current: boolean;
}

export interface KgQueryResult {
  entity: string;
  facts: KgTriple[];
  count: number;
}

export interface PalaceStatus {
  total_drawers: number;
  wings: Record<string, number>;
  rooms: Record<string, number>;
}

export interface DrawerEntry {
  id: string;
  text: string;
  wing: string;
  room: string;
  source_file?: string;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api<T = any>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${MEMPALACE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (MEMPALACE_TOKEN) {
    headers["Authorization"] = `Bearer ${MEMPALACE_TOKEN}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MemPalace ${method} ${path}: HTTP ${res.status} — ${text}`);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isEnabled(): boolean {
  return process.env.MEMPALACE_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacements for qwen-memory + shared-facts
// ---------------------------------------------------------------------------

/**
 * Search drawers. Replaces both `recall()` (with wing="qwen") and
 * `readFactsAsString()` (with wing="shared").
 */
export async function mpSearch(
  query: string,
  opts?: { wing?: string; room?: string; limit?: number },
): Promise<SearchResult[]> {
  try {
    const resp = await api<SearchResponse>("POST", "/search", {
      query,
      limit: opts?.limit ?? 5,
      wing: opts?.wing,
      room: opts?.room,
    });
    return resp.results ?? [];
  } catch (err: any) {
    console.error(`[mempalace] search failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Add a drawer. Replaces both `remember()` (wing="qwen") and
 * `writeFact()` (wing="shared").
 */
export async function mpAddDrawer(
  wing: string,
  room: string,
  content: string,
  opts?: { source_file?: string; added_by?: string },
): Promise<DrawerResult> {
  try {
    return await api<DrawerResult>("POST", "/drawer", {
      wing,
      room,
      content,
      source_file: opts?.source_file,
      added_by: opts?.added_by ?? "qwen",
    });
  } catch (err: any) {
    console.error(`[mempalace] addDrawer failed: ${err?.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * List drawers. Replaces `listMemory()` and `readFacts()`.
 *
 * Adapts the API's flat list shape ({drawer_id, wing, room, content_preview})
 * to our DrawerEntry. Note: content is only a preview here, not the full
 * body — caller must invoke mpGetDrawer() to fetch full content.
 */
export async function mpListDrawers(opts?: {
  wing?: string;
  room?: string;
  limit?: number;
  offset?: number;
}): Promise<DrawerEntry[]> {
  try {
    const resp = await api<{
      drawers?: Array<{
        drawer_id?: string;
        wing?: string;
        room?: string;
        content_preview?: string;
      }>;
    }>("POST", "/drawers/list", {
      wing: opts?.wing,
      room: opts?.room,
      limit: opts?.limit ?? 20,
      offset: opts?.offset ?? 0,
    });
    return (resp.drawers ?? []).map((d) => ({
      id: d.drawer_id ?? "",
      text: d.content_preview ?? "",
      wing: d.wing ?? "",
      room: d.room ?? "",
    }));
  } catch (err: any) {
    console.error(`[mempalace] listDrawers failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Delete a drawer. Replaces `forgetMemory()` and `deleteFact()`.
 */
export async function mpDeleteDrawer(drawerId: string): Promise<boolean> {
  try {
    await api("DELETE", `/drawer/${encodeURIComponent(drawerId)}`);
    return true;
  } catch (err: any) {
    console.error(`[mempalace] deleteDrawer failed: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Update an existing drawer in place. Used by Layer C (channel state) to
 * keep ONE drawer per channel that's overwritten each turn — avoids drawer
 * proliferation from update-by-replace.
 */
export async function mpUpdateDrawer(
  drawerId: string,
  opts: { content?: string; wing?: string; room?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    return await api("PUT", "/drawer", {
      drawer_id: drawerId,
      content: opts.content,
      wing: opts.wing,
      room: opts.room,
    });
  } catch (err: any) {
    console.error(`[mempalace] updateDrawer failed: ${err?.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * Get a single drawer by ID. Used by Layer A (memory pointer pattern) when
 * the model invokes mempalace_get_drawer to re-fetch an evicted tool result.
 *
 * Adapts the API's flat response shape ({drawer_id, content, wing, room,
 * metadata}) to our normalized DrawerEntry ({id, text, wing, room, ...}).
 */
export async function mpGetDrawer(
  drawerId: string,
): Promise<{ drawer?: DrawerEntry; error?: string }> {
  try {
    const raw = await api<{
      drawer_id?: string;
      content?: string;
      wing?: string;
      room?: string;
      metadata?: { source_file?: string; filed_at?: string };
      error?: string;
    }>("GET", `/drawer/${encodeURIComponent(drawerId)}`);
    if (raw.error) return { error: raw.error };
    if (!raw.drawer_id || raw.content === undefined) {
      return { error: "API returned no drawer_id or content" };
    }
    return {
      drawer: {
        id: raw.drawer_id,
        text: raw.content,
        wing: raw.wing ?? "",
        room: raw.room ?? "",
        source_file: raw.metadata?.source_file,
        created_at: raw.metadata?.filed_at,
      },
    };
  } catch (err: any) {
    console.error(`[mempalace] getDrawer failed: ${err?.message ?? err}`);
    return { error: err?.message ?? String(err) };
  }
}

/**
 * Add a knowledge graph triple. For structured facts.
 */
export async function mpKgAdd(
  subject: string,
  predicate: string,
  object: string,
  validFrom?: string,
): Promise<{ success: boolean; triple_id?: string }> {
  try {
    return await api("POST", "/kg/add", {
      subject,
      predicate,
      object,
      valid_from: validFrom,
    });
  } catch (err: any) {
    console.error(`[mempalace] kgAdd failed: ${err?.message ?? err}`);
    return { success: false };
  }
}

/**
 * Query knowledge graph.
 */
export async function mpKgQuery(
  entity: string,
  opts?: { as_of?: string; direction?: string },
): Promise<KgQueryResult> {
  try {
    return await api<KgQueryResult>("POST", "/kg/query", {
      entity,
      as_of: opts?.as_of,
      direction: opts?.direction ?? "both",
    });
  } catch (err: any) {
    console.error(`[mempalace] kgQuery failed: ${err?.message ?? err}`);
    return { entity, facts: [], count: 0 };
  }
}

/**
 * Get palace status.
 */
export async function mpStatus(): Promise<PalaceStatus | null> {
  try {
    return await api<PalaceStatus>("GET", "/status");
  } catch (err: any) {
    console.error(`[mempalace] status failed: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Format search results as a string for system prompt injection.
 * Replaces `readFactsAsString()`.
 */
export async function mpSearchAsString(
  query: string,
  opts?: { wing?: string; room?: string; limit?: number; maxChars?: number },
): Promise<string> {
  const results = await mpSearch(query, opts);
  if (results.length === 0) return "";
  const maxChars = opts?.maxChars ?? 1500;
  const lines: string[] = [];
  let total = 0;
  for (const r of results) {
    const line = `[${r.wing}/${r.room}] ${r.text}`;
    const cost = line.length + 2;
    if (total + cost > maxChars) break;
    lines.push(line);
    total += cost;
  }
  return lines.join("\n");
}
