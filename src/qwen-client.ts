/**
 * qwen-client.ts
 *
 * Thin wrapper around the official `openai` npm SDK pointed at the Qwen vLLM
 * server running on spark-c400. The SDK does 100% of the HTTP work; we just
 * bake in the base URL, model name, and a couple of vLLM-specific knobs.
 *
 * Key design points:
 *  - We disable Qwen3 thinking via `extra_body.chat_template_kwargs.enable_thinking = false`
 *    to sidestep vLLM issue #39056 where the qwen3 reasoning parser siphons
 *    content into `reasoning_content` and leaves `tool_calls` empty.
 *  - Non-streaming. Streaming is a v2 enhancement once vLLM tool-call streaming
 *    is stable (issues #35266, #31871).
 *  - temperature 0.7 / max_tokens 8000 by default; caller may override via opts.
 *  - vLLM's advertised max_model_len on this build is 32768 (NOT 131k).
 */

import OpenAI from "openai";

const DEFAULT_BASE_URL = "http://192.168.1.6:8000/v1";
const DEFAULT_MODEL = "qwen";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Error class emitted when a vLLM request exceeds its timeout. The harness
 * catches this specifically and treats it as a tool failure so the channel
 * mutex gets released rather than wedged forever.
 */
export class QwenTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Qwen vLLM request timed out after ${timeoutMs}ms`);
    this.name = "QwenTimeoutError";
  }
}

export interface QwenChatOpts {
  /** Override tool_choice (default "auto"). Pass "none" to disable tool calls for one turn. */
  tool_choice?: "auto" | "none" | "required";
  /** Override temperature (default 0.7). */
  temperature?: number;
  /** Override max_tokens (default 8000). */
  max_tokens?: number;
  /** Override the model name for this call (rarely needed). */
  model?: string;
  /** Override enable_thinking; default false to avoid vLLM #39056 regression. */
  enable_thinking?: boolean;
  /** Optional abort signal for the request. */
  signal?: AbortSignal;
}

let cachedClient: OpenAI | null = null;

/**
 * Returns a lazily-initialised OpenAI client pointed at the Qwen vLLM server.
 * Exported so callers that need raw access (streaming experiments, embeddings
 * probes, etc.) can share the same configured instance.
 */
export function createQwenClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const baseURL = process.env.QWEN_VLLM_URL || DEFAULT_BASE_URL;
  cachedClient = new OpenAI({
    baseURL,
    // vLLM ignores the key but the SDK insists on one.
    apiKey: process.env.QWEN_API_KEY || "EMPTY",
  });
  return cachedClient;
}

/**
 * Call Qwen via vLLM's OpenAI-compatible chat completions endpoint.
 *
 * `messages` is an OpenAI-format message array (role/content/tool_calls/tool).
 * `tools` is the OpenAI-format tool schema array (see qwen-tools.ts#TOOL_SCHEMAS).
 * Returns the full ChatCompletion so the caller can inspect
 * `choices[0].message.tool_calls` / `.content`.
 */
export async function chat(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionFunctionTool[],
  opts: QwenChatOpts = {},
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const client = createQwenClient();
  const model = opts.model || process.env.QWEN_MODEL_NAME || DEFAULT_MODEL;
  const enableThinking = opts.enable_thinking ?? false;

  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    // vLLM extensions not in the openai SDK type — smuggle through.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra_body?: any;
  } = {
    model,
    messages,
    tools,
    tool_choice: opts.tool_choice ?? "auto",
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: opts.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  };

  // vLLM passes `extra_body` contents into the backend so the chat template
  // can see `enable_thinking`. The openai SDK doesn't type this field, hence
  // the cast above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (body as any).extra_body = {
    chat_template_kwargs: { enable_thinking: enableThinking },
  };

  // Hard request-level timeout so a hung vLLM endpoint can't wedge the
  // channel mutex forever. If the caller passed their own signal we chain
  // our timeout onto it via AbortSignal.any so BOTH can abort the request.
  const timeoutMs = parseInt(
    process.env.QWEN_REQUEST_TIMEOUT_MS ?? String(DEFAULT_REQUEST_TIMEOUT_MS),
    10,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // Node 20+ provides AbortSignal.any to compose caller + timeout signals.
  const signal: AbortSignal =
    typeof AbortSignal.any === "function" && opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;

  try {
    return await client.chat.completions.create(body, { signal });
  } catch (err: unknown) {
    // Map timeout/abort errors to our typed error so the harness can catch
    // them specifically. AbortSignal.timeout produces a TimeoutError with
    // name "TimeoutError"; APIUserAbortError from the openai SDK has name
    // "APIUserAbortError". Either way, treat as a Qwen timeout.
    const e = err as { name?: string; message?: string };
    if (
      e?.name === "TimeoutError" ||
      e?.name === "AbortError" ||
      e?.name === "APIUserAbortError" ||
      (typeof e?.message === "string" && /abort|timed? ?out/i.test(e.message))
    ) {
      throw new QwenTimeoutError(timeoutMs);
    }
    throw err;
  }
}
