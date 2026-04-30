/**
 * Token estimator for context-budgeting inside the Qwen harness.
 *
 * Uses js-tiktoken with the cl100k_base encoder (closest widely-available
 * BPE for counting modern LLM prompts). Encoder is cached on first call.
 *
 * If js-tiktoken fails to load for any reason, falls back to chars / 3.5 —
 * deliberately hotter than the chars/4 rule of thumb because Qwen's
 * tokenizer runs denser on JSON/XML than English prose.
 */
import { createRequire } from "node:module";

type TiktokenEncoder = { encode: (s: string) => number[] | Uint32Array };

let _encoder: TiktokenEncoder | null = null;
let _encoderAttempted = false;
let _encoderFailed = false;

const _require = createRequire(import.meta.url);

function getEncoder(): TiktokenEncoder | null {
  if (_encoderAttempted) return _encoder;
  _encoderAttempted = true;
  try {
    // Lazy require so a missing install is a soft failure, not a crash.
    const tk = _require("js-tiktoken");
    const enc = tk.getEncoding ? tk.getEncoding("cl100k_base") : null;
    if (enc && typeof enc.encode === "function") {
      _encoder = enc as TiktokenEncoder;
      return _encoder;
    }
    _encoderFailed = true;
    return null;
  } catch (err: any) {
    _encoderFailed = true;
    console.error(
      `[token-estimate] js-tiktoken load failed, using fallback: ${err?.message ?? err}`,
    );
    return null;
  }
}

export function estimateTokens(text: unknown): number {
  if (typeof text !== "string") return 0;
  if (text.length === 0) return 0;

  const enc = getEncoder();
  if (enc && !_encoderFailed) {
    try {
      return enc.encode(text).length;
    } catch {
      // fallthrough to heuristic
    }
  }
  return Math.ceil(text.length / 3.5);
}
