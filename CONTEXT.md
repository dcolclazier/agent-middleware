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
`claude`, `qwen`, `nemoclaw`, `conversation`. Used for persistent facts, knowledge
graph, and channel transcripts; not the same as Qwen's local vector memory
(sqlite-vec).

### Channel transcript
Per-channel shared MemPalace drawer set in `wing="conversation"`,
`room=<channelId>`. Each Discord message in a watched channel becomes a drawer
at write time, captured at the bot-routing layer (`bot-instance.ts`) —
independent of which agent (or the user) sent it. Capped at 500 messages per
channel, drop-oldest-on-write. Activity-bounded: never time-expires. The
mechanism that lets Qwen, Claude, and NemoClaw recall what each other said in
the same Discord channel. See ADR-0002, ADR-0004.

### Verbatim window
The last 10 channel-transcript messages, excluding the current agent's own
authored messages, injected verbatim into the system prompt as a
`[CHANNEL CONVERSATION]` block. Provides immediate cross-agent continuity
("what did NemoClaw just say"). Distinct from topical search (`mpSearch`),
which surfaces older relevant content.

### Wire hard cap
The 30 000-token ceiling on any request sent to Qwen vLLM. Below the model's
actual 32 k `max_model_len` to leave ~2 k of safety margin. Enforced via a
pre-flight check after compression. Unlike the previous soft target
(`CONTEXT_SOFT_LIMIT_TOKENS = 25 000`), the wire hard cap is *never* exceeded —
over-budget requests are refused before sending. See ADR-0003.

### System prompt budget
The 8 000-token allocation for the system prompt portion of every Qwen turn.
Sub-allocated as: persona 1 500 / tools+instructions 1 000 / channel state 500 /
verbatim window 2 500 / topical decisions 1 500 / topical prose 500 / margin
500. Persona length is bounded at startup (fail-fast on overrun); everything
else truncates to fit. See ADR-0003.

### Durable fact (Layer B fact)
A structured fact extracted from a Qwen `task_complete.facts` array, written
as a typed drawer in `wing="qwen"` with `room` ∈ {`decision`, `naming`,
`user_preference`, `canon_observation`}. **Not** subject to the channel
transcript's 500-message cap — durable facts live indefinitely until
explicitly forgotten. The retention pathway for important decisions; channel
transcripts are scaffolding for short-term recall.

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
