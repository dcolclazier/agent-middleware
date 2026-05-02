# Context — agent-middleware

Glossary and domain notes for this repo. Update when terminology shifts or a new
concept becomes load-bearing.

## Glossary

### Agent
A long-running AI participant in the system. Three live agents:
- **Claude** — Anthropic API via `claude` CLI subprocesses spawned by this service.
- **Qwen** — Qwen3-235B served by vLLM on Spark #1.
- **NemoClaw** — Gemma-4-26B in an OpenClaw sandbox on Spark #2.
The user (David / CodeMonkey) is the human director.

### Session
A long-running conversation between a Discord channel and an agent. Each Discord
channel maps to **one** Claude session (resumed via `--resume <session-id>`) and
one Qwen harness session. Tracked in `sessions.json` and `qwen-sessions/`.

### Canon
The corpus of in-world content (resistance stories, bestiary entries, world spine,
faction docs, achievements). Source-of-truth files live in
`dcc/SPARK/training_data_truth/canon/`. **Owned by `dcc`, not this repo.**

### Canon commit
Workflow where Qwen/NemoClaw produces a canon document; the middleware writes it
into a per-agent **canon worktree** of dcc, commits to a branch named
`<agent>/canon/<domain>/<subdomain>/<timestamp>`, and (optionally) pushes to
`dcolclazier/dcc` on GitHub. Endpoints: `/api/canon/commit`, `/api/canon/push`,
`/api/canon/status`, `/api/canon/reset`.

### Canon worktree
A `git worktree` of dcc kept separate from the user's main checkout, so canon
branches can be created without disturbing the user's working tree. Path
configured via `CANON_WORKTREE_DIR` (production: `/var/lib/agent-middleware/canon-worktree`).

### Sparse dcc checkout
On Spark #2 (post-migration), a sparse-cone clone of `dcolclazier/dcc` containing
only `SPARK/training_data_truth/canon/`, `SPARK/output/canon/`, `CLAUDE.md`, and
`.claude/`. Avoids cloning the full Unity repo onto a server that doesn't need it.

### Qwen harness
The middleware-owned wrapper around Qwen vLLM that adds tool-calling, session
resume, persona, and vector memory. See `src/qwen-harness.ts`.

### MemPalace
Shared cross-agent memory store at `192.168.1.8:8100` (Spark #2). Wings: `shared`,
`claude`, `qwen`, `nemoclaw`. Used for persistent facts and knowledge graph; not
the same as Qwen's local vector memory (sqlite-vec).

### RAG (canon-search RAG)
The `dcc-canon-rag` service. Currently runs on port 3001. Provides `/embed`
(384-dim all-MiniLM-L6-v2 vectors) and `/search` (Chroma-backed semantic search
over canon corpus). Migrating to Spark #2 alongside this service.

### Standing by sentinel
The literal string `Standing by.` on its own line at the end of a Discord reply.
The bot infrastructure reads it as "this side is done; do not reply." Asymmetric
in failure modes — see CLAUDE.md in dcc for the rule, parsed in
`src/bot-instance.ts`.

### Attachment sentinel
Block of the form `[ATTACHMENT: name.md] ... [/ATTACHMENT]` parsed out of agent
output and converted to Discord file attachments. Implementation:
`src/bot-instance.ts:parseAttachmentSentinels`.

### `/btw`
Channel slash-command for a **side question** that runs in parallel to an
in-flight main turn on the same channel. Detected as a `/btw` prefix on the
post-mention-strip message body in `src/discord-bot.ts:claudeHandler`. Spawns
an ephemeral **side session** (see below); never resumes the channel's main
`claudeSessionId`. Capped at one in-flight `/btw` per channel — a second one
queues with a ⏳ reaction and drains FIFO. Models the "btw, quick question"
interjection a human collaborator would handle without dropping the main
thread.

### `/cancel`
Channel slash-command that interrupts the channel's in-flight Claude turn —
the analog of Ctrl+C in the Claude Code REPL. SIGTERMs the subprocess,
preserves `claudeSessionId` (the next message resumes the same Claude
conversation), drops `messageQueue`, and discards partial output. No-op with
a ⚠️ reaction if there is nothing to cancel. Distinct from `killSession`
(`src/claude-runner.ts`), which marks the session errored and orphans it
from the channel mapping.

### `/end`
Channel slash-command that closes the channel→session mapping — the analog of
Ctrl+D in the Claude Code REPL. If a turn is in flight, runs `/cancel`
internally first. The `Session` row in `sessions.json` is preserved for audit
(re-resumable via `GET /api/sessions/:id`); only the channel mapping is
cleared. The next message in the channel falls through to the
"create new session" path. Payload after `/end` is ignored.

### Side session
The ephemeral, single-turn `Session` spawned by `/btw`. Created with a fresh
Claude session id (no `--resume` of the channel's main session — see ADR-0002),
with a prompt seeded from `fetchChannelContext(...)` plus the main session's
`lastAssistantText` for read-only awareness of the in-flight context. Single
turn: discarded after `complete`, not persisted to `sessions.json`. Posts to
the channel like a normal answer; never overwrites the channel→session mapping.

## Topology after migration

```
Laptop (Windows/WSL)             Spark #2 (192.168.1.8)         Spark #1 (192.168.1.20)
┌─────────────────────┐          ┌─────────────────────────┐    ┌──────────────────┐
│ dev clone of dcc    │          │ agent-middleware :3000  │◄──►│ Qwen3-235B vLLM  │
│ Unity editor        │  push    │ dcc-canon-rag    :3001  │    │ (canon gen)      │
│ Discord client      │  ─────►  │ MemPalace        :8100  │    └──────────────────┘
└─────────────────────┘          │ NemoClaw (sandbox)      │
                                 │ sparse dcc checkout     │
                                 └─────────────────────────┘
```
