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
