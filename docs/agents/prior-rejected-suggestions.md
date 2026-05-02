# Prior rejected review suggestions

Persistent ledger for `/resolve-reviews`. When a review (Copilot or human)
re-raises a suggestion already rejected here with a project-grounded
rationale, the skill auto-applies the prior rejection without re-engaging.

Append, do not edit existing entries. Rationale must cite a concrete
grounding source (ADR-NNNN, `CONTEXT.md` term, or matching code pattern)
so future-you can audit whether the rejection is still valid.

---

- pr: 9
  date: 2026-05-02
  rejections:
    - critique: "checkPersonaBudget() computes total as the sum of per-file token counts. Tokenization is not strictly additive across concatenation boundaries (BPE merges/splits can change counts) — consider computing the authoritative total using a single estimateTokens() over the exact concatenation."
      rationale: "ADR-0003's budget table specifies the persona slot as `SOUL.md + MEMORY.md + IDENTITY.md` (per-file sum) and reserves a separate 500-token `margin` slot for tokenizer drift / formatting overhead. The drift from BPE non-additivity on natural text with whitespace separators is empirically ≤1%, inside that margin. Sum-of-parts also matches the existing test contract in scripts/test-persona-budget.ts."
      file: src/qwen-persona.ts
      line: 41

- pr: 27
  date: 2026-05-02
  rejections:
    - critique: "The new 8-way fan-out/merge helper (`searchTopicalDecisions`) is untested. `scripts/test-topical-recall.ts` only exercises query construction and block rendering, so regressions in the actual mpSearch merge/sort/dedupe path would still pass the added smoketest."
      rationale: "REVIEW-NOTES.md `test-coverage — 2026-05-02` records this as a deliberate /self-review deferred decision: the harness has no DI seam for `mpSearch`, so adding direct unit coverage requires either a `_setMpSearchForTesting` hook in production code or a full integration backend test against `MEMPALACE_ENABLED=true`. Both are out of scope for issue #7's brief. Merge logic is small (sort by similarity desc + dedupe by text), well-typed, and not historically a defect source. Revisit if a regression actually lands."
      file: src/qwen-harness.ts
      line: 1322
    - critique: "The non-MemPalace fallback `prose` is always empty (`prose = mpEnabled() ? searchProse(...) : []`), so when MEMPALACE_ENABLED=false the prior `readFactsAsString` shared-facts source disappears entirely. Deployments running in fallback mode lose the feature."
      rationale: "ADR-0003's budget table replaces the prior `[SHARED FACTS]` block with `[RELEVANT PROSE]` sourced from MemPalace's `conversation` wing. The two are different data sources (durable structured facts vs per-channel transcript history); backfilling `readFactsAsString` into the prose array would conflate them under one block name. If fallback-mode shared-facts visibility is still wanted, the right fix is a separate `[SHARED FACTS]` block restoration as a follow-up — not a prose-block backfill on this PR."
      file: src/qwen-harness.ts
      line: 1463
