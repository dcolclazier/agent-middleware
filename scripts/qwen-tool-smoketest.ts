// Phase 0.1 — verify Qwen3.5-122B XML tool calling works on this vLLM build.
// Tests two paths the agent loop depends on:
//   1. Tool call in response (with enable_thinking:false AND :true, to confirm/refute issue #39056)
//   2. Multi-turn continuation after a tool result message
//
// Run: npx tsx scripts/qwen-tool-smoketest.ts
// Stops the entire Qwen plan if either fails.

import OpenAI from "openai";

const BASE_URL = process.env.QWEN_VLLM_URL ?? "http://192.168.1.6:8000/v1";
const MODEL = process.env.QWEN_MODEL_NAME ?? "qwen";

const client = new OpenAI({ baseURL: BASE_URL, apiKey: "EMPTY" });

const echoTool = {
  type: "function" as const,
  function: {
    name: "echo",
    description: "Echo a string back to the caller. Use this when the user asks you to repeat something.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The text to echo" },
      },
      required: ["message"],
    },
  },
};

async function runOnce(label: string, enableThinking: boolean) {
  console.log(`\n=== ${label} (enable_thinking=${enableThinking}) ===`);

  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a tool-using assistant. When the user asks you to echo something, you MUST call the `echo` tool with the message. Do not respond with text instead.",
    },
    { role: "user", content: 'Please echo back the phrase "smoke test passed".' },
  ];

  // Turn 1 — expect tool call
  const t1 = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: [echoTool],
    tool_choice: "auto",
    max_tokens: 1024,
    temperature: 0.3,
    // @ts-expect-error vLLM-specific extension; openai SDK passes through
    extra_body: { chat_template_kwargs: { enable_thinking: enableThinking } },
  });

  const msg1 = t1.choices[0].message;
  console.log("Turn 1 finish_reason:", t1.choices[0].finish_reason);
  console.log("Turn 1 content:", JSON.stringify(msg1.content));
  console.log("Turn 1 tool_calls:", JSON.stringify(msg1.tool_calls, null, 2));
  // @ts-expect-error vLLM exposes reasoning_content when reasoning parser is on
  if (msg1.reasoning_content) {
    // @ts-expect-error
    console.log("Turn 1 reasoning_content (first 200 chars):", msg1.reasoning_content.slice(0, 200));
  }

  if (!msg1.tool_calls || msg1.tool_calls.length === 0) {
    console.error(`FAIL: ${label} — no tool_calls in response`);
    return false;
  }

  const call = msg1.tool_calls[0];
  if (call.function.name !== "echo") {
    console.error(`FAIL: ${label} — wrong tool called: ${call.function.name}`);
    return false;
  }

  let parsedArgs: any;
  try {
    parsedArgs = JSON.parse(call.function.arguments);
  } catch (e) {
    console.error(`FAIL: ${label} — tool arguments not valid JSON: ${call.function.arguments}`);
    return false;
  }
  console.log("Parsed tool args:", parsedArgs);

  // Turn 2 — feed result back, expect coherent continuation
  messages.push(msg1);
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({ ok: true, echoed: parsedArgs.message }),
  });

  const t2 = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: [echoTool],
    tool_choice: "auto",
    max_tokens: 1024,
    temperature: 0.3,
    // @ts-expect-error
    extra_body: { chat_template_kwargs: { enable_thinking: enableThinking } },
  });

  const msg2 = t2.choices[0].message;
  console.log("Turn 2 finish_reason:", t2.choices[0].finish_reason);
  console.log("Turn 2 content:", JSON.stringify(msg2.content));
  console.log("Turn 2 tool_calls:", JSON.stringify(msg2.tool_calls));

  if (!msg2.content || msg2.content.length < 2) {
    console.error(`FAIL: ${label} — no follow-up content after tool result`);
    return false;
  }

  console.log(`PASS: ${label}`);
  return true;
}

(async () => {
  console.log(`vLLM endpoint: ${BASE_URL}`);
  console.log(`Model: ${MODEL}`);

  let allOk = true;
  try {
    const ok1 = await runOnce("thinking-disabled", false);
    if (!ok1) allOk = false;
  } catch (e) {
    console.error("thinking-disabled crashed:", e);
    allOk = false;
  }

  try {
    const ok2 = await runOnce("thinking-enabled", true);
    if (!ok2) {
      console.warn("(Thinking-enabled failure is expected per vLLM #39056; harness will use enable_thinking:false)");
    }
  } catch (e) {
    console.warn("thinking-enabled crashed:", e);
  }

  console.log("\n=================================");
  if (allOk) {
    console.log("Phase 0.1 SMOKE TEST: PASS (enable_thinking=false works)");
    process.exit(0);
  } else {
    console.log("Phase 0.1 SMOKE TEST: FAIL — STOP THE QWEN PLAN");
    process.exit(1);
  }
})();
