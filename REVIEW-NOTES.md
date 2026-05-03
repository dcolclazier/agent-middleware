## test-coverage — 2026-05-02

**Critique:** `searchTopicalDecisions` (the 8-way fan-out + merge-by-similarity +
text-dedupe helper) has no direct unit test. The smoketest verifies the query
construction (`buildLastUserMessagesQuery`) and the block rendering
(`buildSystemPrompt`) but does not exercise the merge/sort/dedupe logic with a
fake `mpSearch`.

**Decision:** ship despite suggestion.

**Reasoning:** The harness has no injection seam for `mpSearch` today — covering
the merge logic would require either (a) adding a `_setMpSearchForTesting` DI
hook to the production module just for this slice, or (b) wiring a full
integration backend test against `MEMPALACE_ENABLED=true`. Both are out of
scope for issue #7's brief, which calls for a smoketest verifying that "the
search query equals the concatenation of the last 3" and "the two blocks
render with the correct content" — both covered. The merge logic itself is
small (sort by `similarity` desc, dedupe by `text`), well-typed, and has obvious
failure modes that would surface immediately on any real run. If a regression
ever does land here we can revisit and add a DI seam at that point — premature
infrastructure for a function that has not historically been a source of
defects.

---

## /self-review pass on PR #26 — 2026-05-02

`/score --rubric pre-pr` against `dispatch/6-channel-conversation-block`.
Weighted total **9.025/10** after consensus dialogue. Findings dispositioned
below.

### Deferred (real but out of this PR's scope)

- **transcribeIncoming byte cap (security #5).** A bot reply that exceeds
  TURN_BUDGET still gets fully captured into MemPalace via captureOutgoing →
  transcribeIncoming. ADR-0004 explicitly rejected per-message byte caps on
  the basis that upstream `applyOversizeTurnPolicy` filters oversize messages,
  but in current `bot-instance.ts` the transcript write fires BEFORE the
  oversize policy runs (line 1364 vs line 1532). Fixing this requires either
  (a) reordering the calls in bot-instance.ts to put the oversize gate before
  the transcript write (preserves ADR-0004's design intent), or (b) adding
  a defensive byte cap inside writeTurn (defense-in-depth that ADR-0004 calls
  unnecessary). Both touch surfaces outside this PR's verbatim-window slice.
  Track as a follow-up; current behaviour is "noisier transcript wing under
  oversize bot replies" — not exploitable, just disk pressure.

- **selfAuthor end-to-end smoketest (test-coverage #2).** The HTTP body
  field exists and is plumbed; verifying it through the request → harness →
  prompt path needs an HTTP integration harness this repo doesn't have.
  Lock-in via the unit-level `humanUserMessages` test in `test-topical-recall.ts`
  is partial coverage; e2e is left for when the smoketest framework grows.

- **MEMPALACE_ENABLED=false fallback test (test-coverage #3).** Empty-prose
  fallback behaviour is documented in `prior-rejected-suggestions.md` PR #27
  entry. Adding a test that flips the env var mid-script and re-runs
  buildSystemPrompt is meaningful scaffolding for a documented behaviour
  contract, not a code defect — defer.

- **createSession / loadSession humanUserMessages init asymmetry
  (backwards-compat #5).** New sessions get `humanUserMessages: []` from
  `createSession`; legacy sessions don't get the field backfilled at load
  time. Read paths that don't enumerate the field are unaffected; the lazy
  init at the runQwenTurn push site keeps the new-path-on-first-write
  contract intact. Cosmetic invariant gap; document for future readers
  rather than backfill.

- **selfAuthor omission once-per-request log (backwards-compat #3).** Operator
  UX nice-to-have for `/api/qwen/test`. The doc-rot fix in commit `1cd3e4b`
  now names the failure mode in the inline comment; the runtime warning is
  a follow-up if real operators hit it.

- **buildSystemPrompt "exported for tests" jsdoc note (backwards-compat #2).**
  Cosmetic; the only callers are in-repo test scripts and the function is
  a stable shape. If a future external consumer materialises, add the note
  then.

- **Collapse 17-line inline comment block at runQwenTurn:1469-1485
  (readability #2).** Cosmetic comment density; defer to a documentation-only
  cleanup pass.

- **TOPICAL_DECISIONS_WINGS / _ROOMS constants positioning (readability #4).**
  Subjective; their current location next to `searchTopicalDecisions` is
  defensible. No action.

- **Opportunistic legacy fallback migrate (correctness #5).** The legacy
  scan-`messages` fallback is documented as accepted; opportunistic write-on-
  read migration would touch a getter that's currently pure. Defer.

- **Split prose-block scrub from verbatim assertion in test 7b
  (test-coverage #5).** Cosmetic test improvement; current assertion covers
  the helper because both renderers share `sanitizeTranscriptText`.

### Rejected critiques (preserved for future scorers — do not re-suggest)

- **correctness — render functions O(N²) on pathological input.** Conceded
  in dialogue. Practical bound is `K = VERBATIM_WINDOW_K = 10` and
  `wings × rooms × limit = 30` for the topical decisions; worst case is ~30
  tokeniser calls on cached strings. Theoretical defect, not real. Rubric
  anti-pattern: performance speculation without evidence.

- **correctness — verbatim window stale mid-tool-loop.** Conceded in dialogue.
  ADR-0002 frames the channel transcript as turn-grained scaffolding; ADR-0004
  makes the retention contract activity-bounded, not real-time. Mid-loop
  refresh would also break ADR-0003's prompt-budget invariant (system prompt
  computed once per turn). Rubric anti-pattern: re-litigating an ADR boundary.

- **security — awaitPendingWrites unbounded under MemPalace degradation.**
  Conceded in dialogue. The `channelLocks.get(channelId)` returns the *current
  tail* of the per-channel write chain, not the full history; steady-state
  cost ≈ one write's settle time. Burst is bounded by concurrent bots
  (currently 3). Under MemPalace degradation, the reply path is already
  broken; a 1-2s read deadline doesn't restore service.

- **scope-cohesion — rebase `dispatch/6-channel-conversation-block` to drop
  the PR #28 merge.** Conceded in dialogue. Rebase post-merge would (a)
  destroy the conflict-resolution audit trail in `c045f75`, and (b) force-push
  a branch under active Copilot review. The PR body's "Scope drift" section
  pre-discloses #28's footprint.

- **scope-cohesion — `prior-rejected-suggestions.md` PR #27 spillover.**
  Conceded in dialogue. The file is project-wide by design (preamble lines
  3-9); existing PR #9 + PR #28 entries confirm the convention. PR #27 rows
  arriving via merge is the normal mechanism, not spillover.

- **backwards-compat — `humanUserMessages: []` vs `undefined` heuristic.**
  Conceded in dialogue. The current contract is "presence of the field marks
  this session uses the new path." A future "reset" code path that sets `[]`
  is intentionally saying "no human turns to query" — the proposed gate
  would actively break that by re-introducing synthetic-pushback contamination.
  Rubric anti-pattern: forward-looking speculation about a hypothetical
  future writer.

- **diff-cohesion — `928d051` bundles selfAuthor + doc-rot fix.** Self-mitigated
  by the persona; the commit message explicitly enumerates both concerns
  ("Update the harness's now-doc-rotted comment"), so it's a stated grouping
  not a stealth orphan.

### Surface to user (unsure)

- **`REVIEW-NOTES.md` lifecycle (scope-cohesion #3).** This file is per-branch
  ephemera but lives at repo root with no `.gitignore` exclusion or
  cleanup-on-merge note. After PR #26 merges it will persist on `main` and
  accumulate across future branches. Three reasonable conventions:
  (a) `.gitignore` it and treat as scratch (loses commit-history audit
  but keeps `main` clean);
  (b) Move to `docs/review-notes/<branch-slug>.md` so it lives somewhere
  intentional;
  (c) Add a "delete on merge" note in PR body checklists and rely on
  `/post-merge-cleanup` to enforce it.
  Decision left to user — orthogonal to this PR's verbatim-window scope.
