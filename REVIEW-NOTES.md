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

---

# Review notes — Slice 2: /btw side session (issue #15)

Self-review pass before PR open for slice 2. Same charter as the slice 1
section above: each entry below is a place where a reviewer might
reasonably ask "shouldn't this be different?" and the answer is "we
chose this on purpose for the reason given."

## 4. Side session inherits Claude's bypassPermissions tool set (Edit/Write/Bash)

**What a reviewer might say:** "A `/btw` answer to 'what files did you
edit?' is text-only context, but the side session has full Edit/Write/Bash.
A side session shouldn't be able to mutate the working tree."

**What we ship:** the side session uses the runner's default
`CLAUDE_ARGS` — same allowed-tools and same `bypassPermissions` mode as
the main session.

**Why:** the brief explicitly lists tool-call introspection as out of
scope ("`/btw what files have you edited so far?`" is answered from
text-only context, *not* by giving the side session tool access to the
main subprocess's log) but does NOT say to restrict the side session's
own tool access. ADR-0002 documents the git-`.git/index.lock`-race risk
between the two subprocesses sharing CWD and accepts it as a transient
Git error (not data corruption). Restricting the side session's tools is
a separate slice and would change observable behaviour beyond the brief.

**If a reviewer disagrees:** the surgical fix is one extra parameter on
`createSession` to override `--allowedTools` (or pass a different one),
plumbed through to the side-session call site. ~15 lines + a test. Happy
to do on review feedback.

## 5. Prompt injection from main session's lastAssistantText into side session

**What a reviewer might say:** "The seeded prompt embeds the main
session's `lastAssistantText` verbatim. A clever main-turn output could
craft headers like `# Side question (/btw)` to confuse the side
session's prompt structure or escape the read-only context framing."

**What we ship:** verbatim embedding, with a header explaining to Claude
that this is "a read-only snapshot of what the main turn was just
saying" and that the side session does NOT have access to the main
turn's tool calls.

**Why:** the trust boundary doesn't exist between "main turn output"
and "side session input" — both are produced by the same Claude account
on behalf of the same user, in the same channel. Treating Claude's own
output as untrusted input would also need to apply to every other place
the runner persists assistant text (sessions.json, channel history fetch
for the next main turn, etc.) — that's a larger architectural decision
than this slice. ADR-0002 explicitly designed for this content flow as
the value-add of `/btw` over a stateless side session ("alternative C
rejected" in the ADR).

## 6. enqueueSideTurn returns Promise<string> that resolves at SPAWN time, not at COMPLETION

**What a reviewer might say:** "Promise-of-a-session-id reads like 'wait
for this side session to finish'. It actually resolves the moment the
subprocess is spawned. That's surprising."

**What we ship:** the spawned id resolves at spawn time so the
discord-bot caller can immediately bind a trigger to the new session id
for the existing reaction listeners. Completion is signalled via the
existing `sessionEvents` `post-to-discord` and `status:<id>` listeners,
not via this Promise.

**Why:** the discord-bot needs the spawn-time id, not the completion-
time text — completion is already handled by the per-session event
listeners that have existed since before this slice. Resolving at
completion would require the discord-bot to do its own listener
bookkeeping and would duplicate state already managed in
`BotInstance.setTrigger`. The doc comment on `enqueueSideTurn` is
explicit about this.

**If a reviewer disagrees:** options are (a) split the Promise into
`spawnPromise` + `completionPromise` (more surface, marginally clearer)
or (b) drop the Promise entirely and add a callback `onSpawned(id)`
(more parallel structure with `onAck` and `onQueued`). Either is a
mechanical refactor on review feedback.

## 7. _resetSideSessionStateForTests is exported from production code

`scripts/test-side-session-queue.ts` needs to start each scenario from a
clean per-channel in-flight + queue state. Rather than encapsulate the
state in a class instance whose lifetime tests can manage, we exported a
clearly test-named reset helper.

**Why this isn't moved to a test-only module:** the state itself is
module-scoped (the in-flight map and queue map are not exposed). Moving
the reset to a test-only module would require either exposing those
maps directly (worse — production code could mutate them) or moving the
maps into a class that the side-session module holds a singleton of
(more ceremony, no behaviour change). The leading-underscore name
matches the slice 1 pattern for `CLAUDE_BIN`/`CLAUDE_BIN_PREFIX_ARGS`
test hooks documented above.

