# MemPalace — Shared Agent Memory

Unified memory for Claude Code, Qwen, and NemoClaw via MemPalace v3.3.4 hosted on Spark #2.

## Topology

```
Spark #2 (192.168.1.8)                   WSL laptop (192.168.1.32)
┌──────────────────────────────┐         ┌────────────────────────┐
│  vLLM Gemma 4 :8000          │         │  Claude Code           │
│  Middleware :3000  ◄─────────┼─────────┤  └── mcp-proxy.py      │
│  ├── mempalace-client.ts     │         │                        │
│  └── /api/memory/*           │         └────────────────────────┘
│  Canon-RAG :3001             │
│  MemPalace API :8100         │
│  └─ ~/mempalace/             │
│     ├── .venv/               │
│     ├── palace/              │
│     │  ├── chroma            │
│     │  └── kg.sqlite         │
│     └── training_data_truth/ │
└──────────────────────────────┘
```

The middleware that consumes this API lives in this repo (`src/mempalace-client.ts`); canon-RAG source in `dcolclazier/dcc-canon-rag`. Both run as systemd services on Spark #2.

## Wings

| Wing | Source | Purpose |
|------|--------|---------|
| `shared` | Migrated from `facts.jsonl` + new `add_fact` writes | Cross-agent ground truth |
| `claude` | Migrated from `~/.claude/.../memory/` + new MCP writes | Claude Code's private memory |
| `qwen` | Migrated from `qwen-memory.db` + new `remember` writes | Qwen's per-channel context |
| `canon` | `mempalace mine` of `training_data_truth/{canon,factions,world_spine,npc,world_bible}` | Lore reference corpus |
| `facility_ai` | `mempalace mine` of `training_data_truth/facility_ai` | AI behavior corpus |

## Files

- `api-server.py` — FastAPI HTTP wrapper for MemPalace MCP tools (port 8100)
- `mcp-proxy.py` — MCP stdio→HTTP proxy for Claude Code's native MCP integration
- `deploy-to-spark.sh` — Full deploy: install, init, start API server, add @reboot cron

`mine-training-data.sh` lives in the `dcolclazier/dcc` repo at `tools/mempalace/mine-training-data.sh` because it rsyncs and mines `dcc/SPARK/training_data_truth/` into the `canon` and `facility_ai` wings — that script is intrinsically coupled to dcc's content layout, not middleware concerns.

## Operations

### Initial deploy (one-time, already run)
```bash
# Prerequisite: SSH key auth set up — `ssh spark2` works without password.
# (Set up via ssh-keygen + ssh-copy-id; alias defined in ~/.ssh/config.)

# from agent-middleware repo root:
bash tools/mempalace/deploy-to-spark.sh

# then from dcc repo root, to populate canon/facility_ai wings:
bash tools/mempalace/mine-training-data.sh
```

### Restart the API server
```bash
ssh spark2 '
pkill -f "venv/bin/python.*api-server.py"
cd ~/mempalace && nohup .venv/bin/python3 api-server.py >> api-server.log 2>&1 < /dev/null & disown
'
```
On reboot it auto-starts via `@reboot` cron entry.

The `pkill` pattern matches the python process only — a looser pattern like `pkill -f api-server.py` will also match the wrapping SSH bash command that has `api-server.py` in its argv, killing your SSH session along with the server.

### **CRITICAL**: API server cache invalidation
ChromaDB caches its HNSW index in-process. **Any external write to the palace** (running `mempalace mine`, manual sqlite edits, etc.) requires an API server restart — otherwise search returns `Error finding id`. Writes through the API itself are safe.

### Enable in middleware
In this repo's `.env`:
```
MEMPALACE_ENABLED=true
MEMPALACE_URL=http://192.168.1.8:8100
```
Restart the middleware service. Tool executors transparently route to MemPalace.

### NemoClaw access
Memory endpoints exposed at `http://192.168.1.8:3000/api/memory/*` (gated by `canonAuth`):
- `POST /api/memory/search` — `{query, limit, wing, room}`
- `POST /api/memory/store` — `{wing, room, content, source_file, added_by}`
- `POST /api/memory/list` — `{wing, room, limit}`
- `POST /api/memory/kg/add` — `{subject, predicate, object, valid_from}`
- `POST /api/memory/kg/query` — `{entity, as_of, direction}`
- `DELETE /api/memory/drawer/:id`

## Wing usage guidance

- `shared` — facts visible to all agents. Canonical names, project decisions, user preferences.
- `claude` / `qwen` / `nemoclaw` — agent-private notes.
- `canon` / `facility_ai` — read-only reference. Don't write here from agents.
