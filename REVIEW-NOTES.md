# Review notes — Slice 1: /cancel + /end channel commands (issue #14)

Self-review pass before PR open. Records deliberate decisions where the
self-review surfaced a tension between the brief's literal wording and a
consistent, simpler implementation. Each entry below is a place where a
reviewer might reasonably ask "shouldn't this be different?" and the
answer is "we chose this on purpose for the reason given."

## 1. `/end of file is needed` parses as /end (not as prose)

**Brief language:** "prose like `/end of file is needed` is NOT triggered as
a command."

**What the parser does:** treats `/end of file is needed` as the `/end`
verb with payload `of file is needed`, then the handler ignores the
payload and ends the channel session.

**Why we shipped this:** the brief simultaneously requires that the parser
accept `/btw <payload>` (CONTEXT.md → /btw — the *primary documented use
of /btw is as a verb-with-payload*: "/btw quick question"). A
parser-shape rule that rejected `/end of file is needed` while accepting
`/btw quick question` would need per-verb grammars (e.g. /btw permits
words after the verb but /cancel and /end do not), which is more
surface area than the value-add justifies.

The real false-positive class the brief is protecting against — verb
appearing mid-sentence like "I want to /cancel my subscription" or
"the /end keyword in C means..." — IS rejected by the first-token rule.
See scripts/test-slash-commands.ts §5 for the cases we explicitly cover.

A user who literally starts a Discord message with `/end of file is needed`
to discuss EOF semantics is unusual; the same user could write "the /end
of file logic is needed" and the parser correctly leaves it alone.

**If a reviewer disagrees:** the surgical fix is to add a "verb followed
by alphanumeric word ⇒ not-a-command" rule for `/cancel` and `/end` only,
keeping `/btw` permissive. Roughly 10 lines in `src/slash-commands.ts`
and a test-list update; happy to do it on review feedback.

## 2. Reaction-protocol doc lives in bot-instance.ts, but the emit sites for 💀/⚠️/👋 live in discord-bot.ts

**Brief language:** "Reaction emit sites in the `BotInstance` module gain
code comments documenting the protocol meaning of 💀, ⚠️, 👋 (matching
the existing pattern that documents 🤔, 🧑‍💻, ✅, 🔥, 💥)."

**What we did:** added a centralized reaction-protocol doc block at the
top of the BotInstance class in `src/bot-instance.ts` cataloguing every
emoji the system emits, including 💀/⚠️/👋. The actual emit sites for
the three new reactions are in `src/discord-bot.ts:claudeHandler`
(slash-command branch) where they have inline meaning comments too.

**Why:** the brief's "matching the existing pattern" framing assumes
🤔/🧑‍💻/✅/🔥/💥 are emitted from BotInstance. They aren't — they're
emitted from `discord-bot.ts` (status listener and main session ack).
The brief's implicit model of where reactions live didn't quite match
the as-built code. We chose the spirit of the request (centralised
documentation that matches existing pattern) over the letter
(comments at non-existent emit sites in BotInstance for 💀/⚠️/👋).

The new doc block is the most authoritative reference for the protocol
either way.

## 3. CLAUDE_BIN / CLAUDE_BIN_PREFIX_ARGS env hooks introduced for testability

`scripts/test-cancel-turn.ts` needs a long-running process to SIGTERM
without depending on the real `claude` CLI. Rather than refactor
`createSession` to accept an injectable spawner (large blast radius), we
exposed `CLAUDE_BIN` and `CLAUDE_BIN_PREFIX_ARGS` env vars. The test
sets them to `node` + a hang-forever script.

These vars are also genuinely useful in production: deployments with
`claude` outside `$PATH` need exactly this hook today. We've reviewed
that they default to the existing behaviour (`"claude"`, no prefix args)
so no production behaviour change.

If a reviewer prefers a test-only injection seam, the alternative is
adding a `__test_setSpawnImpl(fn)` exported helper, gated by
`NODE_ENV !== "production"`. That trades one form of test-shaped
contamination for another and we judged the env-var path strictly less
intrusive.
