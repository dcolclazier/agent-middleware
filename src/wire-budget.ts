// Wire-budget constants — protocol-level, shared by qwen-harness and the
// Discord routing layer. See docs/adr/0003-hard-wire-cap-and-system-budget.md.
//
// vLLM max_model_len for Qwen3-235B = 32_768; the 2k margin between
// WIRE_HARD_CAP and the model ceiling is tokenizer-drift insurance.
export const WIRE_HARD_CAP = 30_000;
export const SYSTEM_BUDGET = 8_000;
export const TURN_BUDGET = WIRE_HARD_CAP - SYSTEM_BUDGET; // 22_000
