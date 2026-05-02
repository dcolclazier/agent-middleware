# ADR-0004: Activity-bounded transcript retention

**Status:** Accepted — 2026-04-30

## Context

ADR-0002 establishes a per-channel shared transcript in `wing="conversation"`,
`room=<channelId>`. Without a retention policy, two failures stack as the
transcript grows:

1. **`mpSearch` precision degrades.** Top-3 results out of 5 000 noisier
   drawers ≠ top-3 out of 50 high-signal ones. Recall quality drops
   silently as a wing fills.
2. **Storage cost.** Less acute on self-hosted MemPalace, but unbounded
   growth still has a wall.

The user's working pattern is sporadic — often only weekends. A wall-clock
TTL (e.g. "drop transcripts older than 14 days") would erode context exactly
during the long stretches when no work is happening, defeating the purpose:
the user comes back Saturday to find a 6-week-stale conversation thinned
out before they even sit down to type.

The right signal is *activity*, not the calendar.

## Decision

The `conversation` wing is bounded **by message count, per channel**:

- **Cap: 500 messages per channel.**
- **Eviction: drop-oldest-on-write.** When the 501st transcript drawer is
  added to a channel, the oldest is removed atomically.
- **No byte cap.** Q1 of the grilling round (oversized-turn rejection)
  already filters individual messages above `TURN_BUDGET = 22 000` tokens
  before they reach the transcript layer, so a separate byte cap is doing
  no work.

Layer B durable facts (room ∈ `decision` / `naming` / `user_preference` /
`canon_observation` in `wing="qwen"` or `"shared"`) are **not** subject to
this cap. Those rooms hold extracted decisions and structured knowledge —
the things worth keeping forever. The two-tier model:

| Tier              | Wing / room                                | Bound                    | Purpose                              |
| ----------------- | ------------------------------------------ | ------------------------ | ------------------------------------ |
| Channel transcript| `conversation` / `<channelId>`             | 500 messages, drop-oldest| Recent cross-agent prose, scaffolding|
| Durable facts     | `qwen` or `shared` / `decision` etc.       | Unbounded                | Important decisions, persistent      |

## Alternatives considered

- **Wall-clock TTL.** Drop transcripts older than N days. *Rejected:*
  fundamentally wrong signal for sporadic-work projects. Erodes context
  during user-inactive periods — the opposite of what's needed.
- **Summarisation rollup.** When the cap trips, summarise the oldest N
  messages into a single digest drawer instead of dropping. *Rejected
  for now:* requires LLM-call orchestration, prompt engineering for the
  digest pass, and risks summarisation drift. Good idea, premature
  investment. Promotes cleanly to this strategy later if measured recall
  failures justify the cost — change the eviction implementation, not the
  retention policy.
- **Access-based decay.** Drop drawers not retrieved (matched by
  `mpSearch`) in N searches. *Rejected:* requires MemPalace to track
  per-drawer read access — feature add on the server side, not free.
- **No bound.** *Rejected:* search precision degrades; eventual storage
  growth; obscures the "important things go to Layer B" signal.

## Consequences

**Positive.** The user's weekends-only pattern is preserved verbatim:
transcripts are frozen during inactivity, only erode under active churn.
Implementation is dead-simple (a count check on write). No LLM dependency.
The cap is one number, easy to revise. Promotes cleanly to summarisation
if needed without changing the retention contract.

**Negative.** A project with sustained heavy daily usage (e.g. ~50
messages/active-day in a channel) only retains ~10 active days of channel
transcript. Mitigation: the things worth keeping past 10 active days
should be Layer B facts — the design point is that channel transcripts are
*scaffolding*, not archive.

**Neutral.** 500 is a starting point. Revisit after observing real-world
search precision; bumping to 1 000 or 2 000 is a one-line change.

## Follow-ups

- Decide where the cap is enforced: server-side in MemPalace
  (preferred — atomic, auth-checked) or client-side in the middleware on
  every write. If client-side, the `mpAddDrawer` wrapper or the new
  Discord-layer transcript writer needs an eviction step.
- Consider whether explicit "/forget" semantics should also apply to
  channel transcripts, or whether transcripts are by definition transient
  enough that bulk-delete needs a different command (e.g. "/reset
  channel" archiving the entire transcript at once).
- Once Layer B fact extraction is reliably running on every agent's turn
  (not just Qwen's `task_complete`), measure how often a recall miss
  surfaces — that signal tells us when to upgrade to summarisation rollup.

