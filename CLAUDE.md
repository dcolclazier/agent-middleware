# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Discord bot + Claude/Qwen orchestrator. Hosts the `ClaudeCode#1840` and Qwen Discord bots, spawns `claude -p --resume <id>` subprocesses per Discord channel, and exposes an HTTP API on port 3000 for session management, canon commits, and self-restart. Extracted from `dcolclazier/dcc` — see `docs/adr/0001-extracted-from-dcc.md`. Domain glossary in `CONTEXT.md` is load-bearing — read it before naming new concepts.

## Commands

- `npm run dev` — `tsx watch src/index.ts` (development; auto-reloads).
- `npm start` — `tsx src/index.ts` (production-style one-shot; what the self-restart helper invokes).
- `npm run smoketest:overlay` / `:remember` / `:sentinel` / `:truncation` / `:qwen-tools` — standalone `tsx` scripts under `scripts/`. **There is no test framework** (no `vitest`, `jest`, etc.) and **no linter/formatter wired up**. The smoketests are the regression suite; run the relevant one after changes to the area it covers.
- `tsc --noEmit` — type-check only. The build script is intentionally absent; production runs straight `tsx`.

`.env` is loaded manually at `src/index.ts:33` (no `dotenv` dep). Copy `.env.example` to `.env` before first run.

## Architecture

**Entry point: `src/index.ts`.** Express app on `PORT` (default 3000). On startup it loads persisted Claude sessions, then `Promise.allSettled([startDiscordBot(), startQwenBot()])` — a failing Qwen startup must never block ClaudeCode.

**Two parallel agent paths.** They share the HTTP server and crash-safety machinery but otherwise don't talk:

1. **Claude path** — `discord-bot.ts` listens for Discord messages, looks up the channel's session, calls into `claude-runner.ts` which spawns/manages a `claude -p --resume <id>` subprocess. Output is parsed by `bot-instance.ts` for sentinels (`Standing by.`, `[ATTACHMENT: name.md] ... [/ATTACHMENT]`) before being posted back. Each Discord channel maps to **one** Claude session.
2. **Qwen path** — `qwen-bot.ts` → `qwen-harness.ts` (tool loop, session resume, persona, vector memory) → `qwen-client.ts` (vLLM on Spark #1). Persistent state under `qwen-sessions/`, `qwen-persona/`, `qwen-memory.db` — **all paths configurable via env vars and live outside the repo.**

**Canon commit workflow (`src/canon-commit.ts`).** NemoClaw or Qwen produces canon content; the middleware writes it into a per-agent **canon worktree** of `dcc` at `CANON_WORKTREE_DIR`, commits to `<agent>/canon/<domain>/<subdomain>/<timestamp>`, optionally pushes to `dcolclazier/dcc`. **Never use the user's main `dcc` checkout for this** — the worktree exists specifically to keep canon branches off the user's working tree. Endpoints: `/api/canon/{commit,push,status,reset}`.

**Auth model.** Three tiers:
- `/api/health` — public.
- `authMiddleware` (token via `MIDDLEWARE_TOKEN`) — scoped to `/api/sessions`, `/api/channels`, `/api/channel-sessions`, `/api/middleware`. Historically this was a global no-op `app.use`, which was effectively LAN RCE on the Claude CLI. **Do not re-globalise it.**
- `canonAuth` (token + IP allowlist via `CANON_COMMIT_TOKEN` + `CANON_COMMIT_ALLOWED_IPS`) — gates canon, Qwen control, and MemPalace endpoints.

**Self-restart (`POST /api/middleware/restart`).** Spawns a **detached** bash helper that sleeps `delay_ms`, kills this process group, then `cd $MIDDLEWARE_DIR && npm start`. The helper is detached because Claude's CLI runs as a child of this process — an in-process kill would take Claude down before relaunch. Debounced via module-level state. The endpoint flips `expectingRestart = true` so the SIGTERM handler logs cleanly instead of `[FATAL]`.

**Crash safety.** `unhandledRejection` / `uncaughtException` / `SIGTERM` / `SIGINT` all flow through `panicFlushAndExit`, which calls `saveSessions()` and exits non-zero. Running degraded is worse than failing fast — don't add in-process recovery paths.

**External services this depends on:**
- `dcc-canon-rag` (port 3001) — embed/search over `dcc` canon. URLs: `RAG_EMBED_URL`, `CANON_SEARCH_URL`.
- `MemPalace` (port 8100, Spark #2) — shared cross-agent memory. Toggled by `MEMPALACE_ENABLED`.
- Qwen vLLM (Spark #1, `QWEN_VLLM_URL`).
- A clone of `dcolclazier/dcc` at `CLAUDE_CWD` (Claude's cwd) and `CANON_REPO_PATH` (canon worktree base). On Spark #2 this is a **sparse checkout** containing only `SPARK/training_data_truth/canon/`, `SPARK/output/canon/`, `CLAUDE.md`, `.claude/`.

## Conventions worth knowing before editing

- **ESM only.** `"type": "module"` in `package.json`. Internal imports use `.js` extensions even though sources are `.ts` (TS bundler resolution + ESM).
- **No build step in production.** `tsx` runs sources directly; `tsconfig.json`'s `outDir: "dist"` is unused at runtime.
- **All persistent state paths come from env vars** (`CANON_STATE_DIR`, `QWEN_SESSIONS_DIR`, `QWEN_MEMORY_DB`, etc.). Never hardcode relative paths for state — production runs from `/var/lib/agent-middleware/...`.
- **Sentinels are protocol, not cosmetic.** `Standing by.` on its own trailing line tells the bot infrastructure "this side is done; do not reply" — asymmetric in failure modes. Attachment sentinels (`[ATTACHMENT: name.md] ... [/ATTACHMENT]`) are parsed in `src/bot-instance.ts:parseAttachmentSentinels` and converted to Discord file uploads.
- **Canon agents** are validated against the literal set `claude | qwen | nemoclaw` (`src/canon-commit.ts:isValidAgent`). Adding a fourth requires touching that allowlist.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`github.com/dcolclazier/agent-middleware`). Automated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical role names used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
