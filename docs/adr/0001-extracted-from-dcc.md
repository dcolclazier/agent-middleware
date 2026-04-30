# ADR-0001: Extract middleware from `dcolclazier/dcc`

**Status:** Accepted — 2026-04-30
**Source:** `dcolclazier/dcc@ff7c0789` at `claude-middleware/`

## Context

The middleware (Discord bot + Claude/Qwen orchestrator) lived inside the Unity
game repo `dcolclazier/dcc` under `claude-middleware/`. Two problems pushed
extraction:

1. **Reliability.** The middleware ran on the user's Windows/WSL laptop, which
   sleeps, reboots, and loses Wi-Fi. Discord bots and the canon-commit endpoint
   need always-on uptime.
2. **Repo hygiene.** Middleware code is unrelated to the Unity game. It has
   different tech stack (Node/TS), different reviewers, and a different lifecycle.
   Sharing a working tree with the Unity project meant any middleware commit
   inflated `git status` for game work.

## Decision

Split into three repos:

- **`dcolclazier/dcc`** — Unity game + SPARK training pipeline + canon data.
  Unchanged in scope. The canon corpus stays here because the SPARK training
  pipeline reads it.
- **`dcolclazier/agent-middleware`** (this repo) — TypeScript Discord bot +
  Claude/Qwen orchestrator. The runtime still depends on a clone of dcc for
  `CANON_REPO_PATH` (canon worktree) and `CLAUDE_CWD` (Claude CLI cwd), but
  the code is independent.
- **`dcolclazier/dcc-canon-rag`** — Python FastAPI vector-search service over
  the canon corpus. Read-only consumer of dcc canon files via `CANON_DIR` env var.

The middleware's runtime dcc dependency is satisfied on Spark #2 by a **sparse
checkout** of dcc (only `SPARK/training_data_truth/canon/`, `SPARK/output/canon/`,
`CLAUDE.md`, `.claude/`), not a full clone.

## Alternatives considered

- **(B) Carve canon data out of dcc into a fourth repo.** Rejected: would force
  a refactor of the SPARK training pipeline (which reads
  `SPARK/training_data_truth/canon/**`). Couples the migration to a separate,
  larger refactor.
- **(C) Keep middleware in dcc; just relocate it to a Spark.** Rejected: solves
  reliability but not hygiene. Pushing middleware commits would still touch dcc's
  history and require dcc CI to consider middleware changes.
- **Eliminate the local-worktree dependency entirely.** Rejected for now: would
  require canon-commit to do per-call ephemeral clones against the GitHub remote,
  losing the worktree-reuse optimization in `canon-commit.ts`. Revisit if the
  sparse-checkout model proves operationally heavy.

## Consequences

**Positive.** Middleware can be hosted on a 24/7 server without dragging the
Unity project along. Independent CI/release. NemoClaw and the user can iterate
on bot behavior without rebuilding the game.

**Negative.** Two more repos to keep in sync. The middleware's runtime
dependency on a dcc clone is now an explicit deployment concern (sparse
checkout + periodic `git fetch`) rather than an implicit "we're already in dcc"
assumption.

**Neutral.** The `dcolclazier/dcc` worktree this service mutates is at
`CANON_REPO_PATH`. On Spark #2 this is the sparse checkout; on a developer
laptop running this service for testing, it's the full local clone.

## Follow-ups

- ADR-0002 will cover hosting on Spark #2.
- Retire `qwen-memory.db` (sqlite-vec) in favor of MemPalace once the migration
  is stable. Drops `better-sqlite3` + `sqlite-vec` runtime deps.
- Update `CLAUDE_MODEL` default from `claude-opus-4-6` to `claude-opus-4-7`
  (`src/claude-runner.ts:122`).
