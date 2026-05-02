import { type Message, type TextChannel } from "discord.js";

import {
  BotInstance,
  type BotMessageHandler,
  type ReadAttachment,
  type TriggerRef,
} from "./bot-instance.js";
import { knownBotIds } from "./discord-bot.js";
import { runQwenTurn, maybeArchiveSession } from "./qwen-harness.js";

// --- Singleton Qwen bot ---

let qwenBot: BotInstance | null = null;

// --- Display toggle: show/hide Qwen's <think> output in Discord replies ---
//
// Default from QWEN_SHOW_THINKING env var (truthy = show). Can be toggled at
// runtime via `setShowThinking()` (used by the HTTP endpoint and the
// `@Qwen think on/off` inline command).
let showThinking = /^(1|true|yes|on)$/i.test(process.env.QWEN_SHOW_THINKING ?? "");

export function getShowThinking(): boolean {
  return showThinking;
}
export function setShowThinking(v: boolean): void {
  showThinking = !!v;
  console.log(`[Qwen] showThinking = ${showThinking}`);
}

/**
 * Strip Qwen's chain-of-thought leakage from a response string.
 * Qwen (even with `enable_thinking: false`) often emits "<reasoning>…</think>\n\nactual reply"
 * where the opening `<think>` is missing. We remove everything up to and
 * including the LAST `</think>` tag plus any trailing whitespace.
 *
 * If `showThinking` is on, this is a no-op — users can toggle at runtime.
 */
function stripThinkContent(text: string): string {
  if (showThinking) return text;
  const lastClose = text.lastIndexOf("</think>");
  if (lastClose === -1) return text;
  return text.slice(lastClose + "</think>".length).replace(/^\s+/, "");
}

/** Detect the inline `@Qwen think on/off/show/hide` command. Returns new value or null. */
function parseThinkingCommand(content: string): boolean | null {
  const m = /^think(?:ing)?\s+(on|off|show|hide|true|false|yes|no|1|0)\b/i.exec(content.trim());
  if (!m) return null;
  const tok = m[1]!.toLowerCase();
  return tok === "on" || tok === "show" || tok === "true" || tok === "yes" || tok === "1";
}

/**
 * Qwen Discord handler. Unlike the ClaudeCode handler (which speaks to a
 * long-lived per-channel session runtime), runQwenTurn() is a single awaited
 * call that returns the final text. So this handler owns its own reaction
 * lifecycle end-to-end: 🧑‍💻 on dispatch, 🔥 on success, 💥 on error.
 */
const qwenHandler: BotMessageHandler = async (
  self: BotInstance,
  message: Message,
  content: string,
  trigger: TriggerRef,
  attachments: ReadAttachment[],
) => {
  // Prepend any downloaded text attachments to the prompt before handing it
  // to the Qwen harness. `content` is already mention-stripped by BotInstance.
  const attachmentBlock =
    attachments.length > 0
      ? attachments
          .map((a) => `[ATTACHMENT: ${a.name}]\n${a.content}\n[/ATTACHMENT]`)
          .join("\n\n") + "\n\n"
      : "";
  const prompt = (attachmentBlock + content).trim();

  // Inline "@Qwen think on/off" command — human-only (don't let other bots flip it).
  if (!message.author.bot) {
    const thinkToggle = parseThinkingCommand(prompt);
    if (thinkToggle !== null) {
      setShowThinking(thinkToggle);
      try {
        await message.react("✅");
      } catch {
        // non-fatal
      }
      try {
        await (message.channel as TextChannel).send(
          `Qwen thinking output ${thinkToggle ? "**shown**" : "**hidden**"}.`,
        );
      } catch {
        // non-fatal
      }
      return;
    }
  }

  if (!prompt) {
    try {
      await message.reply("I need a message. Try: @Qwen <your question>");
    } catch {
      // non-fatal
    }
    return;
  }

  // Reset / catch-up directives (mirrors ClaudeCode's handler). `reset:`
  // archives the current session file before the new prompt starts, so
  // Qwen begins with a fresh context. The directive token itself is
  // stripped from the prompt text.
  const resetMatch = /^(new task|new session|reset|restart)[\s:,-]+/i.exec(prompt);
  let finalPrompt = prompt;
  if (resetMatch) {
    await maybeArchiveSession(trigger.channelId);
    finalPrompt = prompt.slice(resetMatch[0].length).trim();
    if (!finalPrompt) finalPrompt = "(session reset; no task provided)";
    console.log(
      `[Qwen] reset directive from ${message.author.username}, archived prior session`,
    );
  }

  // In-progress reaction — we don't go through the claude-runner sessionEvents
  // path so we have to poke reactions ourselves.
  await self.safeReact(trigger.channelId, trigger.messageId, "🧑‍💻").catch(() => {});

  try {
    // Pass our own Discord username so readVerbatimWindow can exclude
    // self-authored drawers (issue #6). Symmetric with captureOutgoing's
    // sent.author.username — see channel-transcript writeTurn semantics.
    const selfAuthor = self.getBotUsername() ?? undefined;
    const result = await runQwenTurn(trigger.channelId, finalPrompt, selfAuthor);
    const raw =
      result.finalText && result.finalText.trim().length > 0
        ? result.finalText
        : `(Qwen stopped: ${result.stopReason})`;
    const outText = stripThinkContent(raw);

    // Mention the triggering author if it was another bot (so e.g. NemoClaw
    // can pick up the response).
    const mention =
      trigger.authorIsBot && trigger.authorId ? `<@${trigger.authorId}>` : undefined;

    // If Qwen explicitly attached files via task_complete, send summary + files
    // in a single Discord message. Otherwise fall back to sendOrAttach (which
    // auto-uploads when outText exceeds the inline cap).
    if (result.attachments && result.attachments.length > 0) {
      await self.sendWithFiles(message.channel as TextChannel, outText, result.attachments, {
        mention,
      });
    } else {
      await self.sendOrAttach(message.channel as TextChannel, outText, { mention });
    }
    await self.safeReact(trigger.channelId, trigger.messageId, "🔥").catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Qwen] handler error: ${msg}`);
    try {
      await self.sendOrAttach(message.channel as TextChannel, `Qwen error: ${msg}`);
    } catch {
      // non-fatal
    }
    await self.safeReact(trigger.channelId, trigger.messageId, "💥").catch(() => {});
  }
};

// --- Public API ---

export async function startQwenBot(): Promise<void> {
  const token = process.env.QWEN_BOT_TOKEN;
  if (!token) {
    console.log("QWEN_BOT_TOKEN not set — skipping Qwen Discord bot startup");
    return;
  }

  // Parse a snowflake-id env var (comma-separated, `#`-comment tolerant).
  const parseSnowflakes = (raw: string | undefined): Set<string> => {
    const head = (raw ?? "").split("#")[0]!.trim();
    return new Set(
      head
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d{17,20}$/.test(s)),
    );
  };

  // Scope Qwen to its designated channel(s).
  const allowedChannelIds = parseSnowflakes(process.env.QWEN_CHANNEL_ID);
  if (allowedChannelIds.size === 0) {
    console.warn(
      "[Qwen] QWEN_CHANNEL_ID not set (or no valid snowflake IDs) — bot will respond in ANY channel it's mentioned in. Set QWEN_CHANNEL_ID=<channel id> in .env to scope it.",
    );
  } else {
    console.log(
      `[Qwen] scoped to ${allowedChannelIds.size} channel(s): ${[...allowedChannelIds].join(", ")}`,
    );
  }

  // Role mentions that should count as "a mention of me". Needed when the
  // server has a Discord role named "Qwen" that autocomplete resolves to
  // instead of the bot user — both humans and LLM-generated text can end up
  // producing `<@&roleID>` tokens that `message.mentions.users.has` misses.
  const mentionRoleIds = parseSnowflakes(process.env.QWEN_ROLE_ID);
  if (mentionRoleIds.size > 0) {
    console.log(
      `[Qwen] treating role mention(s) as self: ${[...mentionRoleIds].join(", ")}`,
    );
  }

  qwenBot = new BotInstance({
    displayName: "Qwen",
    // Require a literal "@Qwen" in the message body. This catches:
    //   - Real Discord @-mentions  (always hit the `properMention` branch first)
    //   - Plain-text "@Qwen" from bots like NemoClaw (OpenClaw can't forge
    //     real mentions, so we accept the text form)
    // But NOT bare "qwen" in conversation — the leading @ is required, so
    // "what did qwen say?" is ignored. No `g` flag: BotInstance demands a
    // stateless regex for .test() and builds the replace variant itself.
    textMentionPattern: /@qwen\b[,:\s]*/i,
    knownBotIds,
    allowedChannelIds,
    mentionRoleIds,
    handler: qwenHandler,
  });

  await qwenBot.start(token);
}

export function isQwenBotReady(): boolean {
  return qwenBot !== null && qwenBot.isReady();
}

export function getQwenBot(): BotInstance | null {
  return qwenBot;
}

/**
 * Toggle the Qwen bot's kill switch from an HTTP endpoint. BotInstance
 * currently only exposes the kill-switch via Discord message commands, so
 * we have to drive it through the same code path by injecting a synthetic
 * admin message. Since that path requires a live Discord client, the HTTP
 * endpoint just reports "not ready" if the bot isn't up.
 *
 * For now we simply report the current state; runtime toggling stays a
 * Discord-only affordance until there's a real need for HTTP control.
 */
export function getQwenBotStatus(): { running: boolean; ready: boolean } {
  return {
    running: qwenBot !== null,
    ready: qwenBot !== null && qwenBot.isReady(),
  };
}
