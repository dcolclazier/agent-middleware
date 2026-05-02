# ADR-0002: Channel transcript writes at the Discord-bot layer

**Status:** Accepted — 2026-04-30

## Context

Three agents (Qwen, Claude, NemoClaw) coexist in the same Discord channels,
addressing each other via @-mentions. Cross-agent recall is broken today:

- `mpSearch(wing="qwen")` only returns Qwen's drawers. Qwen cannot find a
  decision NemoClaw made in the same channel.
- The channel-state drawer is per-agent, so each agent's "current task /
  recent decisions" view is fragmented.
- Layer B fact extraction fires only on Qwen's `task_complete` tool call.
  Claude and NemoClaw use the `Standing by.` sentinel as their conversation-
  end signal — but per the user's report, that signal is unreliable (kills
  in-progress conversations incorrectly). Memory extraction must not depend
  on terminal signals from any agent.
- Claude (`src/claude-runner.ts`) has no MemPalace integration at all today.

## Decision

Each Discord message in a watched channel is written as a transcript drawer at
the bot-routing layer (`src/bot-instance.ts`, before the per-bot `handler` is
invoked, plus a paired write after the bot's reply is sent). The write target:

- **Wing:** `conversation`
- **Room:** `<channelId>`
- **Metadata:** `author=<discord username or bot id>`, `timestamp`, plus the
  text body.

All three agents read this same drawer set when constructing their system
prompt — via the verbatim window (most recent N messages by author≠self) and
via topical `mpSearch` against the same wing.

## Alternatives considered

- **(A) Per-agent harness writes.** Qwen's harness writes Qwen's turns; Claude's
  runner gets new MemPalace code; NemoClaw self-reports via the existing
  `/api/memory/store` HTTP endpoint. *Rejected:* three independent code paths,
  and NemoClaw's bot lives in the OpenClaw sandbox on Spark #2 (a different
  repo and deployment), so coordinating a code change there raises the cost of
  every protocol tweak. Failure mode: agent X writes, agent Y forgets,
  recall surfaces a partial transcript.
- **(C) External Discord-tail observer process.** A separate service that
  reads channel history and writes drawers, fully decoupled from middleware.
  *Rejected:* heavyweight; loses MemPalace auth/config integration; adds an
  always-on process for what's better as a hook.

## Consequences

**Positive.** Single integration point. Uniform capture of all participants
including the user (whose messages drive turns and matter for recall).
Independent of `task_complete` / `Standing by.` reliability bugs. NemoClaw is
captured automatically — no Spark #2 coordination. Foundation for future
cross-channel features (multi-channel transcript search, channel summaries).

**Negative.** Tool-internal turns inside `runQwenTurn` (Qwen's own tool
calls/results) are not captured at this layer — those still rely on Layer A's
overlay-eviction-to-drawer pointer mechanism. Two separate write paths now
exist: Discord layer (inter-agent prose) and Layer A (intra-agent tool
reasoning). They are complementary, not redundant, but the mental model has
to be explained.

**Neutral.** Introduces a new MemPalace wing (`conversation`) which is a
convention this codebase establishes; if MemPalace itself ever wants to
enforce a closed wing list, it would have to learn this name.

## Follow-ups

- ADR-0003 — hard wire cap and budget split that depends on this transcript
  being available as a recall source.
- ADR-0004 — activity-bounded retention policy for the new `conversation` wing.
- Decide the exact write hook order: pre-handler write of the incoming
  message; post-handler write of the agent's reply. Likely both, with the
  reply write conditional on a non-empty agent response.
- Migrate `src/qwen-harness.ts:saveChannelState` from `wing="qwen"` to a
  shared wing once the per-agent channel-state pattern is consolidated, or
  retire it in favour of computing channel state from the transcript on demand.

