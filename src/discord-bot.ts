import { type Message } from "discord.js";
import {
  createSession,
  sendMessage,
  getSession,
  sessionEvents,
  cancelTurn,
} from "./claude-runner.js";
import {
  BotInstance,
  type BotMessageHandler,
  type TriggerRef,
  type ChannelRecentEntry,
  type ReadAttachment,
} from "./bot-instance.js";
import { parseSlashCommand } from "./slash-commands.js";
import { enqueueSideTurn } from "./side-session.js";

// --- Shared state across all bots in this process ---
// Each BotInstance adds its own user id to this set on ClientReady so no
// bot in our process ever acks another (prevents cross-bot ack loops).
const knownBotIds = new Set<string>();

export { knownBotIds };

// --- ClaudeCode handler ---
// Owns the session lifecycle, channel history prepending, reset / catch-up
// directives, and follow-up routing. This is the Claude-specific behavior
// that lived in the old module-level handleMessage.

const claudeHandler: BotMessageHandler = async (
  self: BotInstance,
  message: Message,
  initialContent: string,
  trigger: TriggerRef,
  attachments: ReadAttachment[],
) => {
  const channelId = trigger.channelId;
  let content = initialContent;

  const existingSessionId = self.getSessionForChannel(channelId);

  // --- Channel slash-commands (CONTEXT.md → /btw, /cancel, /end) ---
  //
  // Detected BEFORE the existing reset: / catch up regex checks. The
  // parser is first-token-only — `/cancel`, `/end`, and `/btw` only match
  // as the initial token of the post-mention-strip body, so prose that
  // contains those words mid-sentence does not trigger them. `/end
  // <payload>` and `/cancel <payload>` ARE matched (the verb-as-first-
  // token rule); each verb's dispatcher decides what to do with the
  // payload (`/cancel` and `/end` ignore it; `/btw` feeds it into the
  // side-session prompt). Recognition is the same whether or not the bot
  // was @-mentioned, because BotInstance has already stripped the mention
  // by the time we run.
  //
  // /cancel, /end, and /btw all dispatch from this branch (issues #14, #15).
  const slash = parseSlashCommand(content);
  if (slash) {
    const safeReact = async (emoji: string) => {
      try { await message.react(emoji); } catch {
        // non-fatal
      }
    };

    if (slash.verb === "/cancel") {
      // Drive 💀/⚠️ from cancelTurn's actual return rather than a
      // precomputed in-flight flag — the subprocess can exit between
      // the check and the SIGTERM, which would otherwise surface as a
      // false-positive 💀 when the brief says ⚠️.
      const cancelled = existingSessionId ? cancelTurn(existingSessionId) : false;
      await safeReact(cancelled ? "💀" : "⚠️");
      return;
    }
    if (slash.verb === "/end") {
      // /end ALWAYS reacts 👋 and ALWAYS clears the channel mapping (even
      // on an idle channel — clearSessionForChannel is a Map.delete and
      // idempotent for unknown keys, so the unconditional call below
      // matches the doc claim). When a session is in flight, also tear
      // it down: cancelTurn is a no-op when nothing is running, but the
      // explicit guard documents intent. The Session record itself stays
      // in sessions.json so it remains retrievable via the GET-by-id
      // Sessions API; only the channel mapping is cleared.
      //
      // Trigger is also cleared so a subsequently-resumed session via
      // POST /api/sessions/:id/message can't leak its post-to-discord
      // back to this channel via the sessionTriggers lookup path. After
      // /end the channel must be fully dissociated.
      //
      // suppressDiscordPost is set as belt-and-braces against the
      // narrow case where cancelTurn returns false (process already
      // exited naturally between exitCode check and SIGTERM): the close
      // handler still fires, takes the non-cancellation branch, and
      // tries to post the just-finished turn's output. With the trigger
      // cleared, postToDiscord would fall back to TARGET_CHANNEL_ID and
      // post the leftover output to an unrelated default channel.
      // Setting suppressDiscordPost short-circuits the listener.
      if (existingSessionId) {
        cancelTurn(existingSessionId);
        const session = getSession(existingSessionId);
        if (session) session.suppressDiscordPost = true;
        self.clearTrigger(existingSessionId);
      }
      self.clearSessionForChannel(channelId);
      await safeReact("👋");
      return;
    }
    // /btw — spawn an ephemeral side session that runs in parallel to the
    // main turn. ADR-0005: fresh Claude session id (NOT a --resume of the
    // main session). At most ONE in-flight side session per channel; a
    // second /btw queues with ⏳ and drains FIFO. The side session posts
    // its answer to the channel via the existing post-to-discord listener
    // and never overwrites the channel→Session mapping.
    //
    // The trigger we register here binds to the side session id, NOT the
    // main session id — that way the existing per-session status /
    // post-to-discord listeners (which key on session id, not on a
    // main-vs-side flag) emit 🧑‍💻 / 🔥 / 💥 / ✅ on the /btw message that
    // triggered the spawn. The actual reply formatting (mention prefix,
    // attachment sentinels, etc.) is whatever `BotInstance.postToDiscord`
    // does for any session — side sessions get no special handling.
    //
    // We catch async failures from enqueueSideTurn so a thrown promise
    // rejection doesn't take down the message handler; failures are
    // surfaced via 💥 on the /btw message. The most likely failure modes
    // are: (a) the per-channel queue cap being exceeded (a hostile client
    // spamming /btw) and (b) `claude` spawn failure.
    enqueueSideTurn({
      channelId,
      payload: slash.payload,
      channelHistoryProvider: () => self.fetchChannelContext(channelId, message.id, 30),
      mainSessionLookup: () => self.getSessionForChannel(channelId),
      onAck: () => { void safeReact("🤔"); },
      onQueued: () => { void safeReact("⏳"); },
    })
      .then((sideSessionId) => {
        // Bind reactions/post-to-discord for THIS side session to the /btw
        // message that triggered it. The trigger's authorIsBot flag drives
        // whether postToDiscord prepends a mention reply — for /btw from a
        // human, that's no mention; for /btw from a bot, it's an @reply.
        self.setTrigger(sideSessionId, trigger);
        // createSession emits `status:running` synchronously inside
        // enqueueSideTurn — that fires BEFORE this .then() microtask, so the
        // global status listener (which bails when no trigger is bound) misses
        // the running transition and would otherwise skip 🧑‍💻 for /btw.
        // Reconcile by sampling current status here. Subsequent transitions
        // (complete / error) fire from the subprocess close handler, AFTER
        // setTrigger has run, and land via the listener normally.
        const sideSession = getSession(sideSessionId);
        if (sideSession?.status === "running") {
          void safeReact("🧑‍💻");
        }
      })
      .catch((err) => {
        console.error(`[ClaudeCode] /btw side-session dispatch failed: ${err}`);
        void safeReact("💥");
      });
    return;
  }

  // Directive detection runs on the UN-prepended content so an attachment
  // prefix can't accidentally defeat "reset:" / "catch up ..." semantics.
  const isReset = /^(new task|new session|reset|restart)[\s:]/i.test(content);

  // Check for "catch up" / "re-read" directive — fetch channel history and prepend
  const isCatchUp = /^(catch up|catchup|re-?read|read the channel|review the channel)[\s:.,]?/i.test(content);
  if (isCatchUp) {
    const history = await self.fetchChannelContext(channelId, message.id, 50);
    const cleanRequest = content.replace(/^(catch up|catchup|re-?read|read the channel|review the channel)[\s:.,]?\s*/i, "").trim();
    content = `# Channel history (last 50 messages, chronological)\n\n${history}\n\n---\n\n# Current request from ${message.author.username}\n\n${cleanRequest || "Catch up on the conversation and respond."}`;
  }

  // Prepend any text-like file attachments AFTER directive detection but
  // BEFORE the new-session channel-history preamble. Attachments are already
  // downloaded and capped by BotInstance.readAttachments so this is a pure
  // string-shuffle here; if none were provided, content is unchanged.
  if (attachments.length > 0) {
    const attachmentBlock = attachments
      .map((a) => `[ATTACHMENT: ${a.name}]\n${a.content}\n[/ATTACHMENT]`)
      .join("\n\n");
    content = `${attachmentBlock}\n\n${content}`;
    console.log(
      `[ClaudeCode] prepended ${attachments.length} attachment(s) to prompt (${attachmentBlock.length} chars)`,
    );
  }

  if (existingSessionId && !isReset) {
    const session = getSession(existingSessionId);
    if (session && session.status !== "error") {
      try {
        const result = sendMessage(existingSessionId, content);
        const status = result.queued ? "queued" : "sent";
        console.log(`Message ${status} to session ${existingSessionId.slice(0, 8)} (channel ${channelId})`);
        self.setTrigger(existingSessionId, trigger);
        try { await message.react("🤔"); } catch {
          // non-fatal
        }
        return;
      } catch {
        // Session no longer valid, fall through to create new
      }
    }
    self.clearSessionForChannel(channelId);
  }

  // Create a new session — include recent channel history for context
  const cleanContent = isReset ? content.replace(/^(new task|new session|reset|restart)[\s:]\s*/i, "") : content;
  const history = await self.fetchChannelContext(channelId, message.id, 30);

  const prompt = history
    ? `# Recent Discord conversation (for context)\n\n${history}\n\n---\n\n# Current request from ${message.author.username}${message.author.bot ? " (bot)" : ""}\n\n${cleanContent}`
    : cleanContent;

  const session = createSession(prompt, false, false, null);
  self.setSessionForChannel(channelId, session.id);
  self.setTrigger(session.id, trigger);
  console.log(`New session ${session.id.slice(0, 8)} for channel ${channelId} (with ${history ? "history" : "no history"})`);
  try { await message.react("🤔"); } catch {
    // non-fatal
  }
};

// --- Singleton ClaudeCode bot ---

const claudeBot = new BotInstance({
  displayName: "ClaudeCode",
  // Match "@claudecode" or bare "claudecode" as a word. The trailing
  // [,:\s]* lets the strip step eat punctuation immediately after the
  // mention, matching the historical discord-bot.ts behavior. Note: NO `g`
  // flag — BotInstance needs a stateless regex for .test().
  textMentionPattern: /@?\bclaudecode\b[,:\s]*/i,
  knownBotIds,
  handler: claudeHandler,
});

// --- Public API (thin wrappers — unchanged signatures for external callers) ---

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("DISCORD_BOT_TOKEN not set — skipping Discord bot startup");
    return;
  }
  await claudeBot.start(token);
}

export function isDiscordBotReady(): boolean {
  return claudeBot.isReady();
}

export async function postToDiscord(sessionId: string, text: string): Promise<boolean> {
  return claudeBot.postToDiscord(sessionId, text);
}

export function getChannelSessions(): Record<string, string> {
  return claudeBot.getChannelSessions();
}

export async function getChannelRecent(
  channelId: string,
  limit = 30,
): Promise<ChannelRecentEntry[]> {
  return claudeBot.getChannelRecent(channelId, limit);
}

export function getChannelForSession(sessionId: string): string | null {
  return claudeBot.getChannelForSession(sessionId);
}

// --- sessionEvents listeners ---
// Post results / reactions for sessions owned by the ClaudeCode bot.

sessionEvents.on("post-to-discord", async ({ sessionId, text }: { sessionId: string; text: string }) => {
  // Harness-owned sessions (e.g. Qwen's ask_claudecode calls via
  // createSessionAndAwait) set suppressDiscordPost on the session so the
  // result goes only to the Promise caller.
  const session = getSession(sessionId);
  if (session?.suppressDiscordPost) return;

  const trigger = claudeBot.getTrigger(sessionId);
  if (trigger) {
    await claudeBot.safeReact(trigger.channelId, trigger.messageId, "✅");
  }
  await claudeBot.postToDiscord(sessionId, text);
});

sessionEvents.on("status", ({ sessionId, status }: { sessionId: string; status: string }) => {
  const trigger = claudeBot.getTrigger(sessionId);
  if (!trigger) return;
  if (status === "running") {
    claudeBot.safeReact(trigger.channelId, trigger.messageId, "🧑‍💻");
  } else if (status === "error") {
    claudeBot.safeReact(trigger.channelId, trigger.messageId, "💥");
  } else if (status === "complete") {
    claudeBot.safeReact(trigger.channelId, trigger.messageId, "🔥");
  }
});
