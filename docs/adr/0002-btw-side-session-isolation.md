# ADR-0002: `/btw` side sessions use a fresh Claude session id, not concurrent `--resume`

**Status:** Accepted — 2026-05-02
**Related:** `src/discord-bot.ts:claudeHandler`, `src/claude-runner.ts:createSession`, CONTEXT.md → "Side session"

## Context

The `/btw` channel command lets a Discord user ask a side question while the
channel's main Claude turn is still running, so they don't have to wait for
the main turn to finish before getting an answer to a quick aside. (See
CONTEXT.md → `/btw`.)

The middleware's existing model is **one `claude -p --resume <id>` subprocess
per channel session.** When a new message arrives during a running turn, it
goes onto `session.messageQueue` and is delivered after the in-flight
subprocess closes (`src/claude-runner.ts:421`). That serialization is exactly
what `/btw` is meant to bypass.

The naive way to give the side question conversational continuity with the
main turn is to spawn a second subprocess that also resumes the same
`claudeSessionId`. We rejected that.

## Decision

`/btw` spawns a **fresh ephemeral Claude session** — a new Claude session id,
not a resume of the channel's main session. The prompt is seeded with:

1. `fetchChannelContext(channelId, ...)` — recent Discord history (already
   used for new-session creation).
2. The main session's `lastAssistantText`, when present — read-only snapshot
   of what Claude was just saying in the in-flight turn.
3. The user's `/btw` payload.

The side session is single-turn: it runs to `complete`, posts its answer to
Discord, and is discarded. It is not persisted to `sessions.json` and it
never overwrites the channel→session mapping.

## Alternatives considered

- **(B) Have `/btw` resume the channel's main `claudeSessionId` in a second
  subprocess.** Rejected. The Claude CLI persists session state to disk on
  each turn; two subprocesses resuming the same id concurrently race on those
  writes. Observed and reported failure modes in similar tools include lost
  messages, corrupted session files, and "session not found" errors on the
  next legitimate resume. The CLI is not documented as safe under concurrent
  resume of the same id, and the failure mode is **silent corruption of the
  main session** — a strictly worse regression than the feature's value-add.

- **(C) Stateless side session with no main-session context at all** (only
  channel history, no `lastAssistantText`). Rejected as a default. Loses the
  "Claude knows what we were just discussing" property that makes `/btw`
  feel coherent. The marginal cost of injecting `lastAssistantText` into the
  prompt is one map lookup; the marginal benefit is large.

- **(D) Replace the spawn model with a long-lived `claude` REPL subprocess
  per channel and pipe `/btw` to its stdin.** Rejected for now. Would let
  side questions truly share state with the main turn, but requires
  rewriting `claude-runner.ts` from one-shot subprocesses to a persistent
  REPL with stdin/stdout multiplexing — a far larger change than `/btw`
  justifies on its own. Worth revisiting if a future feature (e.g. mid-turn
  amendment / Q0-option-(C)) needs it.

## Consequences

**Positive.**
- Eliminates the concurrent-resume race entirely. The main session id is
  only ever touched by one subprocess at a time.
- The side session has no persistence footprint — `sessions.json` does not
  grow with one entry per `/btw`.
- Implementation is small: one extra map lookup in `claudeHandler` plus a
  new prompt-shape helper.

**Negative.**
- The side session has no access to the main subprocess's tool-call log.
  Questions like "/btw what files have you edited so far?" will be answered
  from text-only context — Claude will see what it *said* it was doing in
  `lastAssistantText`, not what its `Edit` and `Bash` tool calls actually
  did. Documented in the user-facing intro as a known limitation.
- Two parallel `claude` subprocesses share the same `CWD` (typically a dcc
  clone). Git operations from both subprocesses can race on `.git/index.lock`.
  Mitigated by capping `/btw` at one in-flight per channel (so worst case is
  main turn + one side turn, not main + N), but not eliminated. Acceptable
  because the failure mode is a transient Git error in one subprocess, not
  data corruption.

**Neutral.**
- Future features that want true mid-turn interaction (e.g. a `Q0-option-C`
  "amend the in-flight turn" command) cannot be built on top of this — they
  would need the persistent-REPL refactor in alternative (D).

## Follow-ups

- Reactions for the new commands are: `/btw` accepted → 🤔, `/btw` queued
  behind another side turn → ⏳, `/cancel` confirmed → 💀, `/cancel` no-op
  → ⚠️, `/end` confirmed → 👋. Document in `src/bot-instance.ts` near the
  existing reaction emit sites.
- If `/btw` usage grows past "occasional aside" into "second parallel
  conversation," revisit alternative (D) — the limitations of a stateless
  side session will start to bite.
