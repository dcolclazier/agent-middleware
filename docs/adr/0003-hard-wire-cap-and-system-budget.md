# ADR-0003: Hard wire cap with explicit system prompt budget

**Status:** Accepted — 2026-04-30

## Context

Qwen3-235B is served by vLLM with `max_model_len = 32768`. The user's stated
requirement is *"never hits the 32k context limit window."* The current
harness does not actually meet that bar:

- `compressOldMessages` targets `CONTEXT_SOFT_LIMIT_TOKENS = 25 000` but
  preserves the last turn group unconditionally — explicit comment: *"The
  LAST turn group (containing the latest user message) is always preserved,
  even if it alone exceeds the soft limit."* Large user pastes or single
  giant tool results bypass the cap.
- The system prompt is unbounded. `buildSystemPrompt` concatenates persona
  (`SOUL.md` / `MEMORY.md` / `IDENTITY.md`, loaded fresh each turn),
  `[CHANNEL STATE]`, `[SHARED FACTS]`, `[RELEVANT MEMORIES]`, tool list, and
  instructions — each piece has its own char budget but they don't sum to a
  tracked total. Persona drift over time silently inflates every turn.

The combination produces sporadic vLLM 400s on tool-heavy turns or large
pastes — the user's reported failure mode.

## Decision

Replace the soft target with an explicit budget that caps every component:

```
WIRE_HARD_CAP   = 30_000   // never exceed; 2k margin under vLLM's 32k
SYSTEM_BUDGET   =  8_000
TURN_BUDGET     = 22_000   // = WIRE_HARD_CAP - SYSTEM_BUDGET
```

`SYSTEM_BUDGET` sub-allocations:

| Slot                         | Budget | Source                                         |
| ---------------------------- | -----: | ---------------------------------------------- |
| persona                      |  1 500 | `SOUL.md` + `MEMORY.md` + `IDENTITY.md`        |
| tools + instructions         |  1 000 | `TOOL_SCHEMAS` + static instruction block      |
| channel state                |    500 | Layer C — current task / recent decisions      |
| verbatim window              |  2 500 | last 10 channel transcript messages, ≠self     |
| topical decisions            |  1 500 | Layer B facts via `mpSearch` against `qwen` wing |
| topical prose                |    500 | `mpSearch` against `conversation` wing          |
| margin                       |    500 | tokenizer drift / formatting overhead           |
| **total**                    | **8 000** |                                              |

Enforcement points:

1. **Persona over budget at startup → fail-fast.** `qwen-persona.ts` checks
   the loaded persona's token count on first load; if it exceeds 1 500, the
   middleware refuses to start. Persona inflation is a config bug, not a
   runtime concern.
2. **Pre-flight wire-budget re-estimation.** After `compressOldMessages`, a
   new `validateWireBudget` step re-estimates the full `outgoing` array
   including overlay-hydrated tool results. If the total exceeds
   `WIRE_HARD_CAP`, refuse to send and surface a structured error.
3. **Single human user message > `TURN_BUDGET`** → reject in Discord with a
   reply asking the user to chunk or send as an attachment.
4. **Single bot user message > `TURN_BUDGET`** → truncate, post a one-line
   warning in-channel. Bots can't read prose instructions, so the only
   resilience option is silent-with-notification. Matches the existing
   `message.author.bot` branching pattern in `qwen-bot.ts`.
5. **Search-block truncation.** `mpSearchAsString` already takes a `maxChars`;
   wire those caps to the budget table above so they shrink if persona grows
   within budget.

## Alternatives considered

- **Keep the existing 25 k soft target with "preserve last turn group"
  override.** *Rejected:* doesn't actually guarantee the user's stated
  requirement of "never hits 32 k." The whole point of this ADR is to close
  that gap.
- **Adaptive cap = 90% of the model's `max_model_len`.** *Rejected:* sounds
  nice but means the cap moves silently if the model is swapped (e.g. to
  Qwen3-32B-Instruct with a larger context window, which would invite
  bloat). Explicit numbers are easier to reason about and easier to update
  intentionally.
- **No system prompt budget — only cap messages.** *Rejected:* persona,
  facts, and memories can bloat the prompt just as easily as a large turn
  history. The 25 k → 32 k overage in practice is often driven by an
  oversized system prompt, not the messages array.

## Consequences

**Positive.** Deterministic ceiling. Tool-heavy turns can't blow past the
limit. Persona drift is caught at deploy time, not in a 3 a.m. vLLM 400.
Discord users get clear "your message was too big" feedback instead of
silent failures. The budget table is self-documenting — anyone reading
the code can see exactly where the 32 k window is going.

**Negative.** The ~2 k margin between `WIRE_HARD_CAP` and the model's actual
32 k ceiling is "wasted" capacity that could be reclaimed at the cost of
deleting the safety buffer. Sticking with 30 k; budget over-runs in any
single component (e.g. persona at 1 800 instead of 1 500) eat into the
margin rather than the wire cap.

**Neutral.** The sub-allocation numbers are starting points. Revisit if real
usage shows persistent under-allocation in any slot — for example, if
verbatim recall consistently fits in 1 500 instead of 2 500, redirect the
slack to topical decisions.

## Follow-ups

- Implement `validateWireBudget` in `runQwenTurn`, called immediately before
  `chat(outgoing, TOOL_SCHEMAS)`. On overrun, run one more compression pass
  and re-check; if still over, return a structured error to the user.
- Persona startup-validation in `qwen-persona.ts:loadPersona` — token-count
  the loaded markdown against 1 500 and throw a startup error on overrun.
- Surface live budget metrics on the smoke endpoint
  (`POST /api/qwen/test`) so test runs include `system_prompt_tokens`,
  `messages_tokens`, `total_tokens`, and remaining headroom for visibility.
- Replace `CONTEXT_SOFT_LIMIT_TOKENS = 25 000` constant in `qwen-harness.ts`
  with the new cap names; remove the "preserve last turn group" comment that
  documented the old behaviour.

