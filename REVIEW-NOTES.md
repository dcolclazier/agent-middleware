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
