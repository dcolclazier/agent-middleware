# agent-middleware

Discord bot + Claude/Qwen orchestrator. Bridges NemoClaw conversations to Claude
Code sessions and routes Qwen-generated canon to git branches in `dcolclazier/dcc`.

Extracted from [`dcolclazier/dcc`](https://github.com/dcolclazier/dcc) (originally
at `claude-middleware/`). See [`docs/adr/0001-extracted-from-dcc.md`](docs/adr/0001-extracted-from-dcc.md)
for the why.

## What it does

- Hosts the **`ClaudeCode#1840`** Discord bot and the **Qwen** Discord bot.
- Receives Discord messages, spawns `claude -p <prompt> --resume <id>` subprocesses,
  posts the response back to the originating channel.
- Exposes an HTTP API on port 3000 for session management, canon commits, and the
  middleware restart endpoint.
- Manages Qwen vector memory (sqlite-vec) and persona state.
- Runs canon-commit / canon-push against a working clone of `dcc` so NemoClaw can
  publish branches to `dcolclazier/dcc` without touching the user's main checkout.

## Sibling services

- **[`dcc-canon-rag`](https://github.com/dcolclazier/dcc-canon-rag)** (port 3001) —
  vector search over `dcc/SPARK/training_data_truth/canon/**`. The middleware uses
  it for `/embed` (writing into qwen vector memory) and `/search` (Qwen's canon
  lookup tool).
- **MemPalace** (port 8100, on Spark #2) — shared memory palace across Claude,
  Qwen, NemoClaw.

## Runtime requirements

- Node 20+ with native module support (`better-sqlite3`, `sqlite-vec`).
- `claude` CLI on `$PATH`, logged in as the user who owns the Claude account.
- A clone of `dcolclazier/dcc` accessible at `CANON_REPO_PATH` and `CLAUDE_CWD`
  (on Spark #2 this is a sparse checkout containing
  `SPARK/training_data_truth/canon/`, `SPARK/output/canon/`, `CLAUDE.md`, and
  `.claude/`).
- `dcc-canon-rag` reachable at `RAG_EMBED_URL` and `CANON_SEARCH_URL`.

## Setup

```bash
npm install
cp .env.example .env
# Fill in tokens, paths, etc.
npm run dev    # tsx watch mode
# or
npm start      # one-shot
```

## Environment

All configuration via env vars. See [`.env.example`](.env.example) for the full
list with defaults.

## Operations

- **Logs**: stdout/stderr; capture via systemd journal in production.
- **Restart**: `POST /api/middleware/restart` triggers a detached respawn.
- **State**: `qwen-memory.db`, `qwen-sessions/`, `qwen-persona/`, `sessions.json`
  live outside the repo (see `.gitignore`). Configure paths via env vars.

## License

UNLICENSED — internal use.
