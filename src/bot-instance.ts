import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import {
  transcribeIncoming,
} from "./channel-transcript.js";

import { estimateTokens } from "./token-estimate.js";

// --- Types ---

export interface TriggerRef {
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
}

export interface ChannelRecentEntry {
  id: string;
  author: string;
  authorId: string;
  isBot: boolean;
  content: string;
  timestamp: string;
}

/**
 * Contents of a Discord message attachment after we've downloaded it.
 * Only produced for "safe" text-like files (see ALLOWED_ATTACHMENT_EXTS).
 */
export interface ReadAttachment {
  name: string;
  content: string;
}

/** A file that a handler wants to upload alongside an outbound message. */
export interface OutboundFile {
  name: string;
  content: string;
}

/**
 * Harness-specific handler for user messages. The BotInstance does the
 * kill-switch check, mention match, and multi-part stitching; then it
 * delegates to this function, which is responsible for session creation,
 * routing, and any follow-up bookkeeping.
 *
 * `attachments` is the list of downloaded text-like attachments (already
 * fetched via `readAttachments`). Signed Discord URLs expire so we never
 * pass them through to handlers — only the resolved text content.
 */
export type BotMessageHandler = (
  self: BotInstance,
  message: Message,
  content: string,
  trigger: TriggerRef,
  attachments: ReadAttachment[],
) => Promise<void>;

export interface BotInstanceOptions {
  /**
   * Human-readable name used in log lines and in the "enable/disable"
   * acknowledgement that the bot posts to Discord.
   */
  displayName: string;
  /**
   * Regex that matches a text-only mention of this bot in a message body
   * (the @mention-less fallback — e.g. "claudecode" or "qwen"). Used for
   * BOTH the presence check and the strip step, so it MUST NOT carry the
   * `g` flag (stateful lastIndex makes repeated .test() calls flaky).
   * The class will construct a matching global-replace variant internally.
   *
   * OMIT this field (or pass `undefined`) to make the bot STRICTLY require
   * a proper Discord @-mention — useful for bots whose display name is a
   * common word that would produce false positives in conversation.
   */
  textMentionPattern?: RegExp;
  /**
   * Shared across all bots in this process. Each BotInstance adds its own
   * user id on ClientReady and filters incoming messages against the set,
   * so we never ack a peer bot (prevents ack loops between, e.g., Claude
   * and Qwen when both live in the same process).
   */
  knownBotIds: Set<string>;
  /**
   * Optional allowlist of channel IDs this bot is willing to respond in.
   * If undefined OR empty, the bot responds in any channel it can see
   * (legacy behavior for ClaudeCode). If set, messages from other channels
   * are silently dropped — even if the bot is @-mentioned.
   */
  allowedChannelIds?: Set<string>;
  /**
   * Optional role IDs that should count as "mentions of me" when they
   * appear in `message.mentions.roles`. Use this when a Discord server
   * has a role named after the bot (Discord autocomplete can resolve
   * `@BotName` to a role instead of the bot user, producing `<@&roleId>`
   * tokens that `message.mentions.users.has()` never catches).
   */
  mentionRoleIds?: Set<string>;
  /** The harness-specific message handler. */
  handler: BotMessageHandler;
}

// --- Shared helpers ---

function isEnableCommand(content: string): boolean {
  return /^(enable|resume|start|unpause|wake)\b/i.test(content.trim());
}

function isDisableCommand(content: string): boolean {
  return /^(disable|pause|stop|shutup|shut up|stand down)\b/i.test(content.trim());
}

/** Extensions we're willing to download and inline into prompts. */
const ALLOWED_ATTACHMENT_EXTS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
]);

/** 1 MB hard cap on individual attachment size. */
const MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024;

/** Discord message content safe cutoff (hard cap is 2000; leave slack for mentions). */
const MESSAGE_INLINE_MAX = 1900;

/**
 * Outbound message size ceiling. Discord's bot attachment cap is 10MB
 * DECIMAL (10,000,000 bytes) per message. Using `10 * 1024 * 1024` is
 * ~485KB over — Discord 413s at that size. Keep the decimal value.
 */
const OUTBOUND_MESSAGE_BYTE_CAP = 10_000_000;

/** Max files in a single outbound message (harness contract; Discord allows up to 10). */
const OUTBOUND_MAX_FILES_CAP = 5;

// --- Oversized turn handling at the Discord routing layer ---
//
// Per-turn token budget enforced BEFORE the per-bot handler runs. Messages
// over budget are either rejected (human author — ask them to chunk or attach)
// or truncated-with-warning (bot author — keep the conversation flowing but
// clip the body so vLLM doesn't 400). The asymmetry mirrors how
// `parseThinkingCommand` only honours human authors.
//
// 22_000 from ADR-0003 (= WIRE_HARD_CAP − SYSTEM_BUDGET). src/qwen-harness.ts
// re-derives and exports the same value under the same name. Dedupe is
// intentionally deferred: the right fix is to lift WIRE_HARD_CAP /
// SYSTEM_BUDGET / TURN_BUDGET into a shared constants module rather than
// have the Discord routing layer import from a Qwen-specific module (that
// would couple bot-instance.ts to Qwen's harness in the wrong direction).
// Both sides agree on the value today; if ADR-0003's split changes, the
// follow-up extraction is the place to keep them in sync.
export const TURN_BUDGET = 22_000;

/** When a bot author goes over budget, truncate to this fraction of TURN_BUDGET. */
const TURN_TRUNCATE_FRACTION = 0.9;

/** Trailing marker we append to truncated bodies before handing them to the handler. */
const TURN_TRUNCATE_MARKER = "\n\n[truncated]";

/**
 * Decision returned by the pure size-evaluator. Exposed for testing — the
 * routing layer's wiring method consumes the same enum.
 */
export type TurnSizeDecision =
  | { kind: "ok" }
  | { kind: "reject_human"; tokens: number; limit: number }
  | {
      kind: "truncate_bot";
      originalTokens: number;
      truncatedBody: string;
      truncatedTokens: number;
    };

/**
 * Pure decision function: given the (already-prepended) prompt body and
 * whether the originating Discord author is a bot, decide what to do.
 *
 * Rules (issue #5):
 *   - tokens ≤ TURN_BUDGET  →  `{ kind: "ok" }`
 *   - human + over          →  reject (handler aborts, channel reply tells
 *                              the user to chunk or attach the content)
 *   - bot + over            →  truncate to ~90% of TURN_BUDGET, append a
 *                              `[truncated]` marker, continue
 *
 * Token measurement uses the same `estimateTokens` helper as the rest of
 * the harness so the cap stays consistent with downstream pre-flight checks.
 */
export function evaluateTurnSize(
  body: string,
  isBot: boolean,
): TurnSizeDecision {
  const tokens = estimateTokens(body);
  if (tokens <= TURN_BUDGET) return { kind: "ok" };

  if (!isBot) {
    return { kind: "reject_human", tokens, limit: TURN_BUDGET };
  }

  // Bot author: clip the body to ~90% of TURN_BUDGET in token space.
  // estimateTokens isn't reversible, but cl100k_base on ASCII prose is
  // ~3.5 chars/token, so we approximate via char ratio and verify with a
  // re-encode. If the first cut still overshoots (including the trailing
  // [truncated] marker we'll append), we iteratively scale the char budget
  // down by 10% and re-check the FULL body — accounting for the marker
  // inside the loop guarantees the returned `truncatedTokens` actually
  // satisfies the targetTokens invariant rather than overshooting by the
  // marker's token cost.
  const targetTokens = Math.floor(TURN_BUDGET * TURN_TRUNCATE_FRACTION);
  // First-cut char budget: scale down by the token ratio.
  let charBudget = Math.floor((body.length * targetTokens) / Math.max(tokens, 1));
  let truncated = body.slice(0, charBudget);
  let truncatedBody = truncated + TURN_TRUNCATE_MARKER;
  let truncatedTokens = estimateTokens(truncatedBody);
  // Walk down if the FINAL emitted body (content + marker) is still over
  // budget. cl100k_base can run hot on dense structured content.
  let safety = 16;
  while (truncatedTokens > targetTokens && safety-- > 0 && charBudget > 100) {
    charBudget = Math.floor(charBudget * 0.9);
    truncated = body.slice(0, charBudget);
    truncatedBody = truncated + TURN_TRUNCATE_MARKER;
    truncatedTokens = estimateTokens(truncatedBody);
  }
  return {
    kind: "truncate_bot",
    originalTokens: tokens,
    truncatedBody,
    truncatedTokens,
  };
}

/**
 * Split leading `[ATTACHMENT: name]\n…\n[/ATTACHMENT]` blocks back out of a
 * (possibly truncated) prompt body. Used by the oversize-turn policy when a
 * bot message gets truncated: the prepend step folds attachments into the
 * body for size measurement, but the per-bot handler expects (content,
 * attachments) as a split tuple. Without this split, ClaudeCode's directive
 * detection (see discord-bot.ts:claudeHandler — `reset:` / `catch up:` /
 * etc.) would run against a string starting with `[ATTACHMENT: …]` markup
 * and silently never match in the truncation path.
 *
 * Robustness:
 * - Closing-tag boundary: only accept `\n[/ATTACHMENT]` followed by `\n\n`
 *   (the prepend separator before the next block / `[truncated]` marker /
 *   subsequent prose) or end-of-string. Attachment content can legitimately
 *   contain `\n[/ATTACHMENT]` (e.g. a markdown file documenting this very
 *   framing); embedded false-positive closes are skipped and the search
 *   continues for a real boundary-flanked one.
 * - Truncate-mid-attachment: when no boundary-flanked close exists, the cut
 *   landed inside the attachment. We do NOT synthesise a parsed entry for
 *   the partial — downstream renderers re-emit parsed attachments with a
 *   `[/ATTACHMENT]` closing tag that was NOT in the truncated body, which
 *   would push the handler-visible prompt past the cap evaluateTurnSize
 *   already enforced. Instead the partial-attachment tail flows through as
 *   plain `content` (cleanly-closed earlier attachments stay in `parsed`
 *   because their original closing tags survived in the truncated body).
 * - Byte-preservation: only the explicit `\n` / `\n\n` separators we know
 *   were prepended get stripped. We never trim attachment content or the
 *   final trailing prose — readAttachments preserves attachment content
 *   verbatim, and downstream token estimation / directive parsing depends
 *   on those bytes being unchanged.
 *
 * Exported for direct testing — see scripts/test-oversize-turn.ts.
 */
export function splitLeadingAttachmentBlocks(
  body: string,
): { content: string; attachments: ReadAttachment[] } {
  let remaining = body;
  const parsed: ReadAttachment[] = [];
  while (remaining.startsWith("[ATTACHMENT: ")) {
    const headerEnd = remaining.indexOf("]\n");
    if (headerEnd === -1) break;
    const name = remaining.slice("[ATTACHMENT: ".length, headerEnd);
    const contentStart = headerEnd + 2;
    const closingTag = "\n[/ATTACHMENT]";
    let closeIndex = -1;
    let searchFrom = contentStart;
    while (true) {
      const candidate = remaining.indexOf(closingTag, searchFrom);
      if (candidate === -1) break;
      const after = candidate + closingTag.length;
      if (after === remaining.length || remaining.startsWith("\n\n", after)) {
        closeIndex = candidate;
        break;
      }
      // Embedded close that doesn't sit at a boundary — keep looking.
      searchFrom = candidate + 1;
    }
    if (closeIndex === -1) {
      // Truncation cut mid-attachment. Treat the rest as unsplittable: emit
      // `remaining` (the partial `[ATTACHMENT: name]\n<partial-content>`
      // tail, including any trailing `[truncated]` marker) as content. We
      // deliberately don't synthesise a parsed entry — handlers re-render
      // parsed attachments with a `[/ATTACHMENT]` closing tag that the
      // budgeted body never contained, which would silently push the
      // handler-visible prompt past evaluateTurnSize's targetTokens cap.
      // Previously-closed attachments stay in `parsed` (their original
      // closing tags survived intact in the truncated body, so re-emitting
      // them doesn't add synthetic bytes).
      return { content: remaining, attachments: parsed };
    }
    parsed.push({
      name,
      content: remaining.slice(contentStart, closeIndex),
    });
    remaining = remaining.slice(closeIndex + closingTag.length);
    // Only strip the specific `\n` / `\n\n` separator we know was prepended
    // to chain blocks together. Don't trim — readAttachments preserves
    // content verbatim, so trailing prose may legitimately start with
    // whitespace and downstream code is entitled to see it unchanged.
    if (remaining.startsWith("\n\n")) remaining = remaining.slice(2);
    else if (remaining.startsWith("\n")) remaining = remaining.slice(1);
  }
  return { content: remaining, attachments: parsed };
}

// --- Outbound sentinel parser ---
//
// Claude Code CLI emits pure prose — it has no middleware-owned tool to
// attach files the way Qwen's `task_complete({attachments})` does. To let
// Claude produce real Discord attachments, we define a sentinel block that
// Claude can embed in its output:
//
//     [ATTACHMENT: filename.md]
//     full file contents here
//     [/ATTACHMENT]
//
// `parseAttachmentSentinels` extracts these blocks from Claude's final
// assistant text, validates filename + extension + size, and returns the
// cleaned prose plus an OutboundFile[] ready for `sendWithFiles`. Any
// block that fails validation is left in the cleanText verbatim (debug aid
// so users can see what Claude did wrong).
//
// Sentinels inside fenced code blocks (```…``` or ~~~…~~~) are ignored so
// Claude can safely document the format to users without the parser
// eating its own examples.

/** Allowed filename charset: alphanumeric, dots, underscores, dashes. */
const OUTBOUND_NAME_RE = /^[a-zA-Z0-9._-]+$/;
/** Filenames longer than this get rejected (matches filesystem sanity cap). */
const OUTBOUND_NAME_MAX_LEN = 120;
/** Extensions we're willing to emit as attachments (mirrors Qwen's list). */
const OUTBOUND_ALLOWED_EXTS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
]);

/** Result of parsing an assistant text for attachment sentinels. */
export interface ParseResult {
  /** Prose with every VALID sentinel block removed and whitespace normalised. */
  cleanText: string;
  /** Valid attachments in source order. */
  attachments: OutboundFile[];
  /** Non-fatal validation failures. Invalid sentinels stay in cleanText. */
  errors: string[];
}

/**
 * Segment `text` into non-code and fenced-code spans. Returns an array of
 * `{start, end, isCode}` ranges covering the whole string in order. Fenced
 * code blocks use triple backticks or tildes on their own line (with
 * optional leading whitespace and an optional language tag after the
 * opener). Unterminated code blocks are treated as running to end-of-text.
 *
 * We use this so the sentinel parser can skip examples Claude writes
 * inside code blocks when documenting the format.
 */
function findCodeSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  // Match a fence opener: start of line, optional whitespace, 3+ ` or ~.
  const fenceRe = /(^|\n)([ \t]*)(```+|~~~+)[^\n]*/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const openerStart = match.index + (match[1] === "\n" ? 1 : 0);
    const fenceChars = match[3]!;
    // Look for a matching closer: same fence char repeated >= the opener's
    // length, on its own line.
    const closerPattern = new RegExp(
      `\\n[ \\t]*${fenceChars[0] === "\`" ? "`" : "~"}{${fenceChars.length},}[ \\t]*(?=\\n|$)`,
    );
    const afterOpener = match.index + match[0].length;
    const closerMatch = closerPattern.exec(text.slice(afterOpener));
    if (closerMatch) {
      const closerEnd = afterOpener + closerMatch.index + closerMatch[0].length;
      spans.push({ start: openerStart, end: closerEnd });
      fenceRe.lastIndex = closerEnd;
    } else {
      // Unterminated fence — treat the rest of the text as a code span.
      spans.push({ start: openerStart, end: text.length });
      break;
    }
  }
  return spans;
}

function isInsideCodeSpan(
  index: number,
  spans: Array<{ start: number; end: number }>,
): boolean {
  for (const s of spans) {
    if (index >= s.start && index < s.end) return true;
    if (s.start > index) return false; // spans are in order
  }
  return false;
}

/**
 * Parse `[ATTACHMENT: name]\n…\n[/ATTACHMENT]` blocks out of a prose
 * response. See the module-level comment for the full design.
 *
 * Exported so scripts/test-sentinel-parser.ts can exercise it directly.
 */
export function parseAttachmentSentinels(text: string): ParseResult {
  const errors: string[] = [];
  const attachments: OutboundFile[] = [];
  // `[...]` allows anything but close-bracket and newline in the filename;
  // content is a lazy `[\s\S]*?` so the first `[/ATTACHMENT]` wins.
  const sentinelRe =
    /\[ATTACHMENT:\s*([^\]\n]+)\]\n([\s\S]*?)\n\[\/ATTACHMENT\]/g;

  const codeSpans = findCodeSpans(text);

  interface Match {
    start: number;
    end: number;
    name: string;
    content: string;
    valid: boolean;
  }
  const matches: Match[] = [];

  let m: RegExpExecArray | null;
  while ((m = sentinelRe.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (isInsideCodeSpan(start, codeSpans)) {
      // Sentinel lives in a fenced code block — ignore it entirely. The
      // example stays visible to the user as documentation.
      continue;
    }
    const rawName = (m[1] ?? "").trim();
    const content = m[2] ?? "";

    // --- Filename validation ---
    if (rawName.length === 0 || rawName.length > OUTBOUND_NAME_MAX_LEN) {
      errors.push(
        `attachment filename invalid (length ${rawName.length}); sentinel kept inline`,
      );
      matches.push({ start, end, name: rawName, content, valid: false });
      continue;
    }
    if (rawName === "." || rawName === ".." || !OUTBOUND_NAME_RE.test(rawName)) {
      errors.push(
        `attachment filename '${rawName}' must match ${OUTBOUND_NAME_RE}; sentinel kept inline`,
      );
      matches.push({ start, end, name: rawName, content, valid: false });
      continue;
    }
    const dot = rawName.lastIndexOf(".");
    const ext = dot >= 0 ? rawName.slice(dot).toLowerCase() : "";
    if (!OUTBOUND_ALLOWED_EXTS.has(ext)) {
      errors.push(
        `attachment '${rawName}' extension '${ext}' not allowed (allowed: ${[...OUTBOUND_ALLOWED_EXTS].join(", ")}); sentinel kept inline`,
      );
      matches.push({ start, end, name: rawName, content, valid: false });
      continue;
    }

    // --- Per-file size check ---
    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > OUTBOUND_MESSAGE_BYTE_CAP) {
      errors.push(
        `attachment '${rawName}' is ${bytes} bytes, exceeds per-file cap ${OUTBOUND_MESSAGE_BYTE_CAP}; sentinel kept inline`,
      );
      matches.push({ start, end, name: rawName, content, valid: false });
      continue;
    }

    matches.push({ start, end, name: rawName, content, valid: true });
  }

  // Splice out valid matches in reverse order so indices stay stable.
  let cleanText = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const mm = matches[i]!;
    if (!mm.valid) continue;
    cleanText = cleanText.slice(0, mm.start) + cleanText.slice(mm.end);
  }

  // Collapse 3+ consecutive newlines to exactly two, then trim.
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();

  // Build the attachments list in original source order.
  for (const mm of matches) {
    if (mm.valid) attachments.push({ name: mm.name, content: mm.content });
  }

  // --- Per-message 5-file cap ---
  while (attachments.length > OUTBOUND_MAX_FILES_CAP) {
    const dropped = attachments.pop()!;
    errors.push(
      `attachment '${dropped.name}' dropped: exceeds ${OUTBOUND_MAX_FILES_CAP}-file message cap`,
    );
  }

  // --- Total-bytes budget check ---
  // Reserve room for the cleanText bytes; drop tail attachments until the
  // remaining files fit under the Discord 10MB decimal message cap.
  const inlineBytes = Buffer.byteLength(cleanText, "utf-8");
  let budget = OUTBOUND_MESSAGE_BYTE_CAP - inlineBytes;
  if (budget < 0) budget = 0;
  let totalFileBytes = attachments.reduce(
    (a, f) => a + Buffer.byteLength(f.content, "utf-8"),
    0,
  );
  while (totalFileBytes > budget && attachments.length > 0) {
    const dropped = attachments.pop()!;
    const droppedBytes = Buffer.byteLength(dropped.content, "utf-8");
    totalFileBytes -= droppedBytes;
    errors.push(
      `attachment '${dropped.name}' dropped: message total would exceed ${OUTBOUND_MESSAGE_BYTE_CAP} bytes`,
    );
  }

  return { cleanText, attachments, errors };
}

/**
 * Bot-to-bot stop signal. When a BOT posts a message whose FINAL LINE is the
 * phrase "standing by" (tolerant of markdown formatting, emoji, and varied
 * punctuation), other bots treat it as "I'm done, don't reply to this".
 *
 * The match must be anchored to its own line (start of string OR after a
 * newline) to avoid false positives like "I'll be standing by." or
 * "standing by the door." mid-message.
 *
 * Both Claude and Qwen are taught to use the sentinel in their system
 * prompts as a natural sign-off when they've finished a task or
 * acknowledgement and don't need a reply. Humans never trigger this check —
 * they stop conversations by stopping typing.
 *
 * Behavior on match: we still call `safeReact(✅)` so the sender knows the
 * handoff landed, but we skip the LLM round-trip that would produce an
 * auto-reply. The message content IS still visible to whatever came next
 * (via channel history fetched on the next legitimate mention).
 */
const STANDBY_SENTINEL_RE = /(^|\n)[\s*_~`>]*standing by[\s*_~`!.?…]*$/i;

function hasStandbySentinel(content: string): boolean {
  return STANDBY_SENTINEL_RE.test(content.trim());
}

// --- Reaction protocol ---
//
// Discord reactions are PROTOCOL across this module, `discord-bot.ts`,
// and `qwen-bot.ts`. Each emoji has a fixed meaning the user (and
// downstream tooling) relies on. The agent-turn lifecycle reactions
// (🧑‍💻/🔥/💥) are intentionally bot-agnostic — Claude and Qwen turns
// share the visual vocabulary even though the underlying transport
// (subprocess vs OpenAI-compatible HTTP) differs. Add new reactions
// here when you wire them up so the table stays authoritative.
//
//   👀  message received and is being processed
//        emitter: BotInstance.handleMessage (this file)
//   ✅  acknowledged (three distinct emit sites):
//          - kill-switch enable command processed
//          - standby-sentinel observed in a session reply
//          - session's final text is ready and is being posted to the
//            channel (fired on the trigger message just BEFORE
//            postToDiscord delivers the reply, not after — the post
//            itself can still fail asynchronously)
//        emitter: BotInstance.handleMessage; discord-bot.ts
//   🛑  bot disabled by user kill-switch command
//        emitter: BotInstance.handleMessage
//   🤔  thinking — a Claude turn has been queued/sent OR a /btw was
//        accepted to spawn immediately (CONTEXT.md → /btw)
//        emitter: discord-bot.ts (claudeHandler)
//   🧑‍💻 agent turn started (in progress)
//        Claude: subprocess transitioned to "running"
//        Qwen:   harness dispatched the turn to vLLM
//        emitters: discord-bot.ts (status listener); qwen-bot.ts
//   🔥  agent turn completed successfully
//        Claude: subprocess transitioned to "complete"
//        Qwen:   harness response landed without error
//        emitters: discord-bot.ts (status listener); qwen-bot.ts
//   💥  agent turn ended with error
//        Claude: subprocess transitioned to "error"
//        Qwen:   harness threw or vLLM returned a non-OK status
//        emitters: discord-bot.ts (status listener); qwen-bot.ts
//   💀  /cancel confirmed — in-flight turn was torn down (CONTEXT.md → /cancel)
//        emitter: discord-bot.ts (claudeHandler) — Claude only; Qwen does
//        not implement /cancel today.
//   ⚠️  /cancel no-op — nothing was in flight to cancel
//        emitter: discord-bot.ts (claudeHandler)
//   👋  /end confirmed — channel→session mapping cleared (CONTEXT.md → /end)
//        emitter: discord-bot.ts (claudeHandler) — Claude only.
//   ⏳  /btw queued behind another in-flight side session for the same
//        channel (CONTEXT.md → /btw, Side session); will drain FIFO
//        emitter: discord-bot.ts (claudeHandler)

// --- Class ---

export class BotInstance {
  private client: Client | null = null;
  private botUserId: string | null = null;
  private botDisabled = false;

  // channelId → sessionId mapping for multi-turn conversations
  private readonly channelSessions = new Map<string, string>();

  // sessionId → triggering message reference so we can update reactions and
  // reply to the correct sender when async work finishes.
  private readonly sessionTriggers = new Map<string, TriggerRef>();

  private readonly displayName: string;
  private readonly textMentionPattern: RegExp | null;
  private readonly textMentionStripPattern: RegExp | null;
  private readonly knownBotIds: Set<string>;
  private readonly allowedChannelIds: Set<string> | null;
  private readonly mentionRoleIds: Set<string> | null;
  private readonly handler: BotMessageHandler;

  constructor(opts: BotInstanceOptions) {
    this.displayName = opts.displayName;
    if (opts.textMentionPattern) {
      if (opts.textMentionPattern.flags.includes("g")) {
        throw new Error(
          `BotInstance(${opts.displayName}): textMentionPattern must not carry the 'g' flag (stateful lastIndex breaks repeated .test() calls)`,
        );
      }
      this.textMentionPattern = opts.textMentionPattern;
      // Build a separate global-flag variant for the strip step so the
      // detection regex stays stateless.
      const stripFlags = opts.textMentionPattern.flags.includes("g")
        ? opts.textMentionPattern.flags
        : opts.textMentionPattern.flags + "g";
      this.textMentionStripPattern = new RegExp(
        opts.textMentionPattern.source,
        stripFlags,
      );
    } else {
      this.textMentionPattern = null;
      this.textMentionStripPattern = null;
    }
    this.knownBotIds = opts.knownBotIds;
    this.allowedChannelIds =
      opts.allowedChannelIds && opts.allowedChannelIds.size > 0
        ? opts.allowedChannelIds
        : null;
    this.mentionRoleIds =
      opts.mentionRoleIds && opts.mentionRoleIds.size > 0
        ? opts.mentionRoleIds
        : null;
    this.handler = opts.handler;
  }

  // --- Lifecycle ---

  async start(token: string): Promise<void> {
    if (!token) {
      console.log(`[${this.displayName}] no token provided — skipping startup`);
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.once(Events.ClientReady, (c) => {
      this.botUserId = c.user.id;
      this.knownBotIds.add(c.user.id);
      console.log(`[${this.displayName}] Discord bot ready: ${c.user.tag} (id: ${this.botUserId})`);
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    try {
      await this.client.login(token);
    } catch (err) {
      console.error(`[${this.displayName}] Discord bot login failed: ${err}`);
      this.client = null;
    }
  }

  isReady(): boolean {
    return this.client !== null && this.client.isReady();
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  // --- Session bookkeeping ---

  getChannelSessions(): Record<string, string> {
    return Object.fromEntries(this.channelSessions.entries());
  }

  setSessionForChannel(channelId: string, sessionId: string): void {
    this.channelSessions.set(channelId, sessionId);
  }

  getSessionForChannel(channelId: string): string | undefined {
    return this.channelSessions.get(channelId);
  }

  clearSessionForChannel(channelId: string): void {
    this.channelSessions.delete(channelId);
  }

  setTrigger(sessionId: string, trigger: TriggerRef): void {
    this.sessionTriggers.set(sessionId, trigger);
  }

  getTrigger(sessionId: string): TriggerRef | undefined {
    return this.sessionTriggers.get(sessionId);
  }

  /**
   * Forget the trigger for a session.
   *
   * Called from /end so a subsequently-resumed session (e.g. via
   * `POST /api/sessions/:id/message`) doesn't leak its post-to-discord
   * back to the previously-associated channel via the trigger lookup
   * path. The Session record itself is preserved (per CONTEXT.md →
   * /end); only the channel-association sticker is removed.
   */
  clearTrigger(sessionId: string): void {
    this.sessionTriggers.delete(sessionId);
  }

  getChannelForSession(sessionId: string): string | null {
    const trigger = this.sessionTriggers.get(sessionId);
    if (trigger) return trigger.channelId;
    for (const [cid, sid] of this.channelSessions.entries()) {
      if (sid === sessionId) return cid;
    }
    return null;
  }

  // --- Transcript capture helper ---

  /**
   * Fire-and-forget: record an outgoing reply in the channel transcript.
   * Routes through `transcribeIncoming` keyed on the sent Discord message's
   * id so sibling BotInstances that observe the same MessageCreate event
   * don't write a duplicate drawer. Author is taken from `sent.author`
   * (the bot's actual Discord username) so it matches what `handleMessage`
   * records for inbound messages — keeping `readVerbatimWindow`'s
   * exclude-by-author filter symmetric across directions.
   *
   * No-op when MEMPALACE_ENABLED=false (handled inside the module).
   */
  private captureOutgoing(sent: Message, text: string): void {
    void transcribeIncoming(
      sent.channel.id,
      sent.id,
      sent.author.username,
      text,
      new Date(sent.createdTimestamp).toISOString(),
    );
  }

  // --- Discord helpers ---

  async safeReact(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.react(emoji);
    } catch {
      // Reaction failures are non-fatal
    }
  }

  /**
   * Fetch the last N messages from a channel and format them as a context preamble.
   * Excludes the triggering message itself (which will be the user's prompt).
   */
  async fetchChannelContext(
    channelId: string,
    excludeMessageId: string,
    limit = 30,
  ): Promise<string> {
    if (!this.client) return "";
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return "";

      const messages = await (channel as TextChannel).messages.fetch({ limit });
      // Discord returns newest-first; reverse to chronological
      const ordered = Array.from(messages.values()).reverse();
      const filtered = ordered.filter((m) => m.id !== excludeMessageId && m.content.trim().length > 0);

      if (filtered.length === 0) return "";

      const lines = filtered.map((m) => {
        const name = m.author.bot ? `${m.author.username} (bot)` : m.author.username;
        // Normalize mention tokens into SEMANTIC placeholders derived from
        // the message's own mention collections. If we just wrote the literal
        // string "@mention", the downstream LLM would learn to type "@mention"
        // in its own replies — a confirmed failure mode. Instead we rewrite
        // user and role mentions to `[@username]` / `[@rolename]` using the
        // real name from discord.js's parsed mention collections.
        let clean = m.content.replace(/\[session [a-f0-9]+\]\s*/g, "");
        clean = clean.replace(/<@!?(\d+)>/g, (_match, id: string) => {
          const u = m.mentions.users.get(id);
          return u ? `[@${u.username}]` : "[@user]";
        });
        clean = clean.replace(/<@&(\d+)>/g, (_match, id: string) => {
          const r = m.mentions.roles.get(id);
          return r ? `[@${r.name}]` : "[@role]";
        });
        return `[${name}]: ${clean.trim()}`;
      });

      return lines.join("\n");
    } catch (err) {
      console.error(`[${this.displayName}] Failed to fetch channel context: ${err}`);
      return "";
    }
  }

  /**
   * Fetch additional messages from the same author that came right before the trigger
   * (catches multi-part Discord messages where only the first chunk had the @mention).
   */
  async fetchSameAuthorChunks(
    channelId: string,
    triggerMessageId: string,
    authorId: string,
    windowSeconds = 30,
  ): Promise<string[]> {
    if (!this.client) return [];
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return [];

      const before = await (channel as TextChannel).messages.fetch({
        limit: 20,
        before: triggerMessageId,
      });

      const ordered = Array.from(before.values()); // newest-first
      const triggerMsg = await (channel as TextChannel).messages.fetch(triggerMessageId);
      const triggerTime = triggerMsg.createdTimestamp;

      const chunks: string[] = [];
      for (const msg of ordered) {
        if (msg.author.id !== authorId) break;
        if (triggerTime - msg.createdTimestamp > windowSeconds * 1000) break;
        chunks.push(msg.content);
      }

      return chunks.reverse();
    } catch (err) {
      console.error(`[${this.displayName}] Failed to fetch same-author chunks: ${err}`);
      return [];
    }
  }

  async getChannelRecent(channelId: string, limit = 30): Promise<ChannelRecentEntry[]> {
    if (!this.client || !this.client.isReady()) return [];
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return [];

      const messages = await (channel as TextChannel).messages.fetch({ limit });
      return Array.from(messages.values())
        .reverse()
        .map((m) => ({
          id: m.id,
          author: m.author.username,
          authorId: m.author.id,
          isBot: m.author.bot,
          content: m.content,
          timestamp: new Date(m.createdTimestamp).toISOString(),
        }));
    } catch (err) {
      console.error(`[${this.displayName}] Failed to fetch channel recent: ${err}`);
      return [];
    }
  }

  /**
   * Send `text` to a Discord channel. If `(mention + text)` fits within the
   * inline cap, send as-is. Otherwise TRUNCATE and append a marker, plus any
   * @mention tokens that would have been lost to the truncation.
   *
   * Design principle: attachments are ALWAYS explicit. This method never
   * auto-uploads long text as a file — that previously duplicated the
   * message into the attachment (violating the "don't duplicate content"
   * rule) and made the preceding-explanation guarantee impossible. To send
   * a file, callers must use `sendWithFiles({summary, files})` with an
   * explicit, non-empty summary.
   *
   * Mention preservation: Pass 1 introduced the invariant that long bot
   * responses must still fire downstream bot triggers. Under truncation we
   * keep that invariant by extracting user/role mention tokens from the
   * FULL text, and appending any that didn't survive the truncation as a
   * deduplicated tail-line. So if Claude's 3000-char reply contains
   * `<@qwenId>` at char 2500, Qwen still gets pinged.
   */
  async sendOrAttach(
    channel: TextBasedChannel,
    text: string,
    opts?: { mention?: string },
  ): Promise<void> {
    if (!("send" in channel)) return;

    const mention = opts?.mention ?? "";
    const full = mention ? `${mention} ${text}` : text;

    if (full.length <= MESSAGE_INLINE_MAX) {
      const sent = await (channel as TextChannel).send(full);
      this.captureOutgoing(sent, text);
      return;
    }

    // --- Truncation path (no file upload) ---
    // Extract every mention from the FULL text so we can restore any that
    // land past the truncation point. We DEDUPE against the surviving body
    // so mentions already inside the truncated portion don't get repeated
    // in the tail — that would cause double-ping (Test 4 in the unit test).
    const allMentionTokens = Array.from(
      new Set([
        ...Array.from(text.matchAll(/<@!?\d+>/g), (m) => m[0]),
        ...Array.from(text.matchAll(/<@&\d+>/g), (m) => m[0]),
      ]),
    );

    const originalLen = text.length;
    // Reserve space for the mention prefix, the restored-mention tail, and
    // the truncation marker. We build the tail first so we know the budget.
    const marker = `\n\n[truncated ${originalLen} chars — use structured task_complete attachments for long content]`;
    const mentionPrefix = mention ? `${mention} ` : "";

    // Two-pass budget: first try WITH all lost mentions restored in the
    // tail. If that blows the cap, fall back to no restored tail (existing
    // mentions inside the truncated body still ping if they happen to fit).
    const buildOutput = (includeRestoredTail: boolean): string => {
      // Compute a tentative body budget assuming no tail, then see which
      // mentions actually survive the cut, then compute the real tail with
      // only the LOST mentions, then recompute the body budget.
      const noTailBodyBudget = Math.max(
        0,
        MESSAGE_INLINE_MAX - mentionPrefix.length - marker.length,
      );
      const tentativeBody = text.slice(0, noTailBodyBudget);
      const survivingMentions = new Set(
        allMentionTokens.filter((tok) => tentativeBody.includes(tok)),
      );
      const lostMentions = allMentionTokens.filter(
        (tok) => !survivingMentions.has(tok),
      );
      const restoredTail =
        includeRestoredTail && lostMentions.length > 0
          ? `\n\n[also: ${lostMentions.join(" ")}]`
          : "";
      const bodyBudget = Math.max(
        0,
        MESSAGE_INLINE_MAX - mentionPrefix.length - restoredTail.length - marker.length,
      );
      const body = text.slice(0, bodyBudget);
      return `${mentionPrefix}${body}${restoredTail}${marker}`;
    };

    let out = buildOutput(true);
    if (out.length > MESSAGE_INLINE_MAX) {
      // Lost-mentions tail alone doesn't fit. Fall back: skip the tail,
      // keep whatever mentions happen to live inside the truncated body.
      out = buildOutput(false);
      console.warn(
        `[${this.displayName}] sendOrAttach: too many mentions to preserve in truncation tail (${allMentionTokens.length})`,
      );
    }
    if (out.length > MESSAGE_INLINE_MAX) {
      // Safety floor: clip to the cap as a last resort.
      out = out.slice(0, MESSAGE_INLINE_MAX);
    }

    const sent = await (channel as TextChannel).send(out);
    // Capture the FULL pre-truncation text — the transcript is for AGENT
    // memory, not for what humans saw. Truncation is a Discord-display
    // concern.
    this.captureOutgoing(sent, text);
  }

  /**
   * Send a short human-readable summary alongside one or more explicit file
   * attachments in a SINGLE Discord message.
   *
   * Design principle: attachments are ALWAYS explicit and ALWAYS come with a
   * human-readable explanation inline. The summary is that explanation —
   * it is REQUIRED and cannot be empty, omitted, or demoted to a file.
   * If the caller's summary is too long to fit inline, we throw rather than
   * auto-demote; the caller is responsible for producing a short summary.
   *
   * Rules (all throw on violation):
   *  - `summary` must be non-empty after trim.
   *  - `(mention + summary)` must fit inline (≤ MESSAGE_INLINE_MAX chars).
   *  - `files.length` must be ≤ 5 (matches harness-level validation).
   *  - total bytes (summary UTF-8 + all file contents) must be ≤ 10MB decimal.
   *  - Empty `files` array falls back to `sendOrAttach` for consistency.
   */
  async sendWithFiles(
    channel: TextBasedChannel,
    summary: string,
    files: OutboundFile[],
    opts?: { mention?: string },
  ): Promise<void> {
    if (!("send" in channel)) return;

    if (files.length === 0) {
      await this.sendOrAttach(channel, summary, { mention: opts?.mention });
      return;
    }

    const mention = opts?.mention ?? "";

    // --- Structural validation ---
    if (typeof summary !== "string" || summary.trim().length === 0) {
      throw new Error(
        "sendWithFiles: summary is required; attachments must be preceded by an explanation",
      );
    }
    if (files.length > OUTBOUND_MAX_FILES_CAP) {
      throw new Error(
        `sendWithFiles: max ${OUTBOUND_MAX_FILES_CAP} files (got ${files.length})`,
      );
    }

    const inline = mention ? `${mention} ${summary}` : summary;
    if (inline.length > MESSAGE_INLINE_MAX) {
      throw new Error(
        `sendWithFiles: summary too long for inline Discord message (${inline.length} > ${MESSAGE_INLINE_MAX} chars); caller must shorten it`,
      );
    }

    // --- Byte-budget check ---
    // Discord's per-message cap is 10MB DECIMAL (10,000,000 bytes), not
    // binary 10*1024*1024. Using decimal keeps us strictly below the wire
    // limit.
    const summaryBytes = Buffer.byteLength(summary, "utf-8");
    const fileBytes = files.reduce(
      (acc, f) => acc + Buffer.byteLength(f.content, "utf-8"),
      0,
    );
    const totalBytes = summaryBytes + fileBytes;
    if (totalBytes > OUTBOUND_MESSAGE_BYTE_CAP) {
      throw new Error(
        `sendWithFiles: total message size ${totalBytes} bytes exceeds ${OUTBOUND_MESSAGE_BYTE_CAP} (Discord per-message cap)`,
      );
    }

    // --- Send ---
    const attachments: AttachmentBuilder[] = files.map(
      (f) => new AttachmentBuilder(Buffer.from(f.content, "utf-8"), { name: f.name }),
    );
    const sent = await (channel as TextChannel).send({
      content: inline,
      files: attachments,
    });
    // Transcript records the inline summary (the human-visible prose).
    // Attachment file bodies are intentionally excluded; if a downstream
    // agent needs an attachment's contents, it should re-fetch via the
    // canon RAG / dcc layer rather than rehydrate megabytes from MemPalace.
    this.captureOutgoing(sent, summary);
  }

  /**
   * Download any "safe" text-like attachments from a Discord message.
   * Signed Discord CDN URLs expire ~24h so we fetch now and never persist
   * the URL. Rejects unknown extensions and anything over 1 MB. Fetch
   * failures are logged but not thrown — other attachments still get
   * returned.
   */
  async readAttachments(message: Message): Promise<ReadAttachment[]> {
    const out: ReadAttachment[] = [];
    for (const att of message.attachments.values()) {
      const name = att.name ?? "attachment";
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : "";
      if (!ALLOWED_ATTACHMENT_EXTS.has(ext)) {
        console.log(
          `[${this.displayName}] skipping attachment ${name} (unsupported extension: ${ext || "none"})`,
        );
        continue;
      }
      if (att.size > MAX_ATTACHMENT_BYTES) {
        console.log(
          `[${this.displayName}] skipping attachment ${name} (${att.size} bytes > 1 MB cap)`,
        );
        continue;
      }
      try {
        const res = await fetch(att.url);
        if (!res.ok) {
          console.error(
            `[${this.displayName}] attachment fetch ${name} failed: HTTP ${res.status}`,
          );
          continue;
        }
        const content = await res.text();
        out.push({ name, content });
      } catch (err) {
        console.error(`[${this.displayName}] attachment fetch ${name} errored: ${err}`);
      }
    }
    return out;
  }

  /**
   * Post a session's final assistant text to its Discord channel.
   *
   * Flow:
   *  1. Parse `[ATTACHMENT: name]…[/ATTACHMENT]` sentinels out of the text
   *     (see `parseAttachmentSentinels` for the format — Claude's prose-only
   *     path to producing real Discord file attachments, symmetric with
   *     Qwen's `task_complete({attachments})` tool call).
   *  2. Rewrite `@nemoclaw` text mentions to proper Discord role pings on
   *     the cleaned inline text.
   *  3. If attachments were found, route to `sendWithFiles` so the Discord
   *     message has inline explanation + real file cards. Otherwise fall
   *     through to `sendOrAttach` (truncation path for long prose).
   *
   * Parse errors (malformed sentinels, bad filenames, oversized files) are
   * logged and their sentinels remain in the cleaned text so the sender
   * can see what went wrong in the next conversation turn.
   */
  async postToDiscord(sessionId: string, text: string): Promise<boolean> {
    if (!this.client || !this.client.isReady()) return false;

    const trigger = this.sessionTriggers.get(sessionId);

    let channelId: string | null = trigger?.channelId || null;
    if (!channelId) {
      for (const [cid, sid] of this.channelSessions.entries()) {
        if (sid === sessionId) {
          channelId = cid;
          break;
        }
      }
    }
    if (!channelId) {
      channelId = process.env.TARGET_CHANNEL_ID || null;
    }
    if (!channelId) return false;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;

      const mention = trigger?.authorIsBot && trigger.authorId ? `<@${trigger.authorId}>` : undefined;

      // --- Pass 7b: parse outbound sentinels before rewriting/sending ---
      const parsed = parseAttachmentSentinels(text);
      if (parsed.errors.length > 0) {
        console.warn(
          `[${this.displayName}] postToDiscord: ${parsed.errors.length} parse error(s) for session ${sessionId.slice(0, 8)}:`,
        );
        for (const e of parsed.errors) console.warn(`  - ${e}`);
      }

      // Apply the NemoClaw mention rewrite to the cleaned inline text only
      // (never to attachment contents — files aren't parsed for mentions).
      const nemoclawId = process.env.NEMOCLAW_BOT_ID || "";
      let processedText = parsed.cleanText;
      if (nemoclawId) {
        processedText = processedText.replace(/@nemoclaw\b/gi, `<@${nemoclawId}>`);
      }

      if (parsed.attachments.length > 0) {
        // If Claude emitted only sentinels with no prose, generate a
        // placeholder inline so sendWithFiles' non-empty-summary contract
        // holds and the message still has a human-readable header.
        if (processedText.trim().length === 0) {
          const names = parsed.attachments.map((a) => a.name).join(", ");
          processedText = mention
            ? `${mention} [attached: ${names}]`
            : `[attached: ${names}]`;
          console.warn(
            `[${this.displayName}] postToDiscord: sentinel-only response, generated placeholder inline (${names})`,
          );
        }
        try {
          await this.sendWithFiles(
            channel as TextChannel,
            processedText,
            parsed.attachments,
            { mention },
          );
        } catch (err) {
          // sendWithFiles can still throw (e.g. inline too long AFTER
          // mention rewrite). Fall back to sendOrAttach on the cleaned
          // text so the user at least sees Claude's prose.
          console.error(
            `[${this.displayName}] postToDiscord: sendWithFiles failed (${err instanceof Error ? err.message : String(err)}); falling back to sendOrAttach on prose only`,
          );
          await this.sendOrAttach(channel as TextChannel, processedText, { mention });
        }
      } else {
        await this.sendOrAttach(channel as TextChannel, processedText, { mention });
      }

      return true;
    } catch (err) {
      console.error(`[${this.displayName}] Discord post failed for session ${sessionId.slice(0, 8)}: ${err}`);
      return false;
    }
  }

  /**
   * Apply the issue-#5 oversized-turn policy to an inbound prompt body.
   *
   * Side effects on the channel:
   *   - human + over → posts a one-line reply naming the limit and asking
   *     for chunking or a file attachment; returns `{ abort: true }` so the
   *     caller skips the per-bot handler.
   *   - bot + over → posts a one-line warning identifying the originating
   *     bot and the truncation length; returns `{ abort: false, body }` with
   *     the truncated body (plus `[truncated]` marker) for the handler.
   *   - under budget → no send; returns `{ abort: false, body }` unchanged.
   *
   * The body parameter is the FULL prompt the per-bot handler will see,
   * including any prepended `[ATTACHMENT: …]` blocks. Attachments must NOT
   * bypass the cap, so callers fold them in BEFORE calling this.
   *
   * Public so the smoke script can exercise the wiring side-effects against
   * a stub channel without booting Discord.
   */
  async applyOversizeTurnPolicy(
    channel: TextBasedChannel,
    body: string,
    isBot: boolean,
    authorName: string,
  ): Promise<{ abort: boolean; body: string }> {
    const decision = evaluateTurnSize(body, isBot);
    if (decision.kind === "ok") {
      return { abort: false, body };
    }

    if (!("send" in channel)) {
      // No way to surface the warning; degrade by aborting on human, passing
      // through truncated body on bot. Logging keeps the operator informed.
      console.warn(
        `[${this.displayName}] oversized-turn policy: channel has no send(); decision=${decision.kind}`,
      );
      if (decision.kind === "reject_human") return { abort: true, body };
      return { abort: false, body: decision.truncatedBody };
    }

    if (decision.kind === "reject_human") {
      // Derive the suggested-extensions list from ALLOWED_ATTACHMENT_EXTS so
      // the user-facing reply can't drift from what readAttachments actually
      // accepts when the allowlist evolves.
      const allowedExtList = Array.from(ALLOWED_ATTACHMENT_EXTS)
        .sort((a, b) => a.localeCompare(b))
        .join("/");
      const reply =
        `Your message is ~${decision.tokens} tokens, over the per-turn cap of ${decision.limit}. ` +
        `Please chunk the message into smaller pieces, or attach the content as a file ` +
        `(${allowedExtList}).`;
      try {
        // allowedMentions: { parse: [] } neutralises any user/role/everyone
        // pings that might be smuggled in via interpolation. tokens/limit
        // here are integers and the ext list is a constant, so the current
        // payload is safe — but we apply the defensive form for parity with
        // the bot-truncate warning below, where authorName IS user-controlled.
        await (channel as TextChannel).send({
          content: reply,
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.warn(
          `[${this.displayName}] oversized-turn reject reply failed: ${err}`,
        );
      }
      console.log(
        `[${this.displayName}] OVERSIZE-REJECT: ${authorName} sent ${decision.tokens} tokens (cap ${decision.limit})`,
      );
      return { abort: true, body };
    }

    // Bot + over: truncate, warn, continue.
    const warning =
      `⚠ ${authorName} message truncated from ${decision.originalTokens} to ${decision.truncatedTokens} tokens`;
    try {
      // authorName is user-controlled (Discord username); a name containing
      // "@everyone" / "@here" / `<@id>` / `<@&id>` would mass-mention or
      // ping someone unintentionally. allowedMentions: { parse: [] }
      // neutralises every mention type so this warning never pings anyone
      // regardless of what the originating bot's name happens to be.
      await (channel as TextChannel).send({
        content: warning,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.warn(
        `[${this.displayName}] oversized-turn warning failed: ${err}`,
      );
    }
    console.log(
      `[${this.displayName}] OVERSIZE-TRUNCATE: ${authorName} ${decision.originalTokens}→${decision.truncatedTokens} tokens`,
    );
    return { abort: false, body: decision.truncatedBody };
  }

  // --- Core message dispatch ---

  private async handleMessage(message: Message): Promise<void> {
    // Drop our OWN messages only — we never respond to ourselves (prevents
    // recursive self-handling when posting to the channel we listen in).
    // Other bots in this process (e.g. Qwen receiving a message from
    // ClaudeCode, or vice versa) are legitimate conversation partners; the
    // mention filter + bot-chain cap below are the real ack-loop protection.
    if (this.botUserId && message.author.id === this.botUserId) return;

    // Channel allowlist: drop anything outside our declared channels (when set).
    if (this.allowedChannelIds && !this.allowedChannelIds.has(message.channel.id)) {
      return;
    }

    // --- Channel transcript capture (slice #2) ---
    // Persist every message we observe in a watched channel into the
    // shared MemPalace conversation wing BEFORE the per-bot mention filter.
    // The dedupe inside transcribeIncoming makes this idempotent across
    // multiple BotInstances seeing the same MessageCreate event. No-op
    // when MEMPALACE_ENABLED is not "true". Failures are swallowed inside
    // the module; never block the bot reply path on transcript failure.
    void transcribeIncoming(
      message.channel.id,
      message.id,
      message.author.username,
      message.content,
      new Date(message.createdTimestamp).toISOString(),
    );

    // STRICT: respond ONLY to (a) a proper user @mention, (b) a mention of one
    // of our configured mention-roles, or (c) a text-match against our
    // fallback pattern. Role mentions exist because Discord autocomplete can
    // resolve "@BotName" to a role of the same name — we treat that role as
    // equivalent to a user mention when it's explicitly registered.
    const properMention = this.botUserId != null && message.mentions.users.has(this.botUserId);
    let roleMention = false;
    if (this.mentionRoleIds) {
      for (const roleId of this.mentionRoleIds) {
        if (message.mentions.roles.has(roleId)) {
          roleMention = true;
          break;
        }
      }
    }
    const textMention =
      this.textMentionPattern !== null &&
      this.textMentionPattern.test(message.content);
    if (!properMention && !roleMention && !textMention) return;

    // --- Bot-to-bot standby sentinel ---
    // If another bot ends its message with a "Standing by." sign-off, they're
    // signalling "I'm done, no reply needed". We still react ✅ so the sender
    // and observers can see the handoff landed, but we skip our LLM
    // round-trip. The content remains visible in channel history for the
    // next legitimate turn. Humans never trigger this — they stop typing
    // rather than emit a sentinel. This is how we break ack-loops without
    // capping legitimate multi-turn collaboration.
    if (message.author.bot && hasStandbySentinel(message.content)) {
      console.log(
        `[${this.displayName}] STANDBY-ACK: ${message.author.username} signalled standby, reacting ✅ and suppressing reply`,
      );
      await this.safeReact(message.channel.id, message.id, "✅");
      return;
    }

    // Strip mentions from the content for downstream processing. Use the
    // global-flag variant so ALL occurrences are removed. Also strip role
    // mentions (both configured and unconfigured) so Claude/Qwen never see
    // `<@&id>` tokens in the prompt they'd otherwise echo back.
    let content = message.content
      .replace(/<@!?\d+>/g, "")   // user mentions
      .replace(/<@&\d+>/g, "");   // role mentions
    if (this.textMentionStripPattern) {
      content = content.replace(this.textMentionStripPattern, "");
    }
    content = content.trim();

    // --- Kill switch handling ---
    // Only humans can toggle; this prevents NemoClaw-style bot acks from
    // accidentally disabling us, or a loop from flipping the state.
    if (!message.author.bot) {
      if (this.botDisabled && isEnableCommand(content)) {
        this.botDisabled = false;
        try { await message.react("✅"); } catch {
          // non-fatal
        }
        try {
          await (message.channel as TextChannel).send(
            `${this.displayName} re-enabled. Back to normal operation.`,
          );
        } catch {
          // non-fatal
        }
        console.log(`[${this.displayName}] enabled by ${message.author.username}`);
        return;
      }
      if (!this.botDisabled && isDisableCommand(content)) {
        this.botDisabled = true;
        try { await message.react("🛑"); } catch {
          // non-fatal
        }
        try {
          await (message.channel as TextChannel).send(
            `${this.displayName} disabled. I will ignore all messages until you @${this.displayName} enable.`,
          );
        } catch {
          // non-fatal
        }
        console.log(`[${this.displayName}] disabled by ${message.author.username}`);
        return;
      }
    }

    if (this.botDisabled) {
      console.log(`[${this.displayName}] dropped message from ${message.author.username} (bot disabled)`);
      return;
    }

    // React immediately so the user knows we saw the message
    try {
      await message.react("👀");
    } catch {
      // non-fatal
    }

    // Stitch in any preceding messages from the same author within 30s
    const priorChunks = await this.fetchSameAuthorChunks(
      message.channel.id,
      message.id,
      message.author.id,
      30,
    );
    if (priorChunks.length > 0) {
      content = priorChunks.join("\n\n") + "\n\n" + content;
      console.log(`[${this.displayName}] stitched ${priorChunks.length} prior chunks from ${message.author.username}`);
      // Re-trim after stitching: priorChunks[0] can carry leading whitespace
      // that survives the join. Keep the stitched content normalized here so
      // size checks and the handler see the same post-stitch text, preventing
      // leading/trailing whitespace from slipping past the cap.
      content = content.trim();
    }

    if (!content) {
      try {
        await message.reply(`I need a message. Try: @${this.displayName} <your question>`);
      } catch {
        // non-fatal
      }
      return;
    }

    const trigger: TriggerRef = {
      channelId: message.channel.id,
      messageId: message.id,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
    };

    // Download any text-like attachments up front; signed URLs expire ~24h,
    // so we never want handlers to see raw Attachment refs. Failures inside
    // readAttachments are swallowed per-file; it always returns a (possibly
    // empty) array.
    let attachments: ReadAttachment[] = [];
    try {
      attachments = await this.readAttachments(message);
    } catch (err) {
      console.error(`[${this.displayName}] readAttachments failed: ${err}`);
    }

    // --- Issue #5: oversized-turn policy at the Discord routing layer ---
    // Compose the prompt the per-bot handler will see (mention-stripped
    // content + any prepended [ATTACHMENT: ...] blocks) and run it through
    // the size policy BEFORE invoking the handler. Attachments must NOT
    // bypass the cap, so they go into the measurement here.
    const attachmentBlock =
      attachments.length > 0
        ? attachments
            .map((a) => `[ATTACHMENT: ${a.name}]\n${a.content}\n[/ATTACHMENT]`)
            .join("\n\n") + "\n\n"
        : "";
    // No `.trim()` here: `content` was already trimmed (after mention-strip
    // and again after priorChunks stitching), and `attachmentBlock` either
    // ends with `\n\n` or is empty, so the composition has no leading or
    // trailing whitespace. Trimming again would re-introduce the
    // measurement / handler-input mismatch this trim discipline avoids.
    const composedBody = attachmentBlock + content;
    const policy = await this.applyOversizeTurnPolicy(
      message.channel as TextBasedChannel,
      composedBody,
      message.author.bot,
      message.author.username,
    );
    if (policy.abort) {
      return;
    }

    // Hand off to the per-bot handler while preserving the existing
    // (content, attachments) split — even when the oversize policy
    // truncated the combined body. Without this, ClaudeCode's directive
    // detection (`reset:` / `catch up:` etc., see discord-bot.ts:claudeHandler)
    // would run against a string starting with `[ATTACHMENT: ...]` markup
    // and silently never match. The helper is module-level so smoke tests
    // can exercise it directly — see splitLeadingAttachmentBlocks above.
    let handlerContent = content;
    let handlerAttachments = attachments;
    if (policy.body !== composedBody) {
      if (attachments.length > 0) {
        const split = splitLeadingAttachmentBlocks(policy.body);
        handlerContent = split.content;
        handlerAttachments = split.attachments;
      } else {
        handlerContent = policy.body;
        handlerAttachments = [];
      }
    }

    try {
      await this.handler(this, message, handlerContent, trigger, handlerAttachments);
    } catch (err) {
      console.error(`[${this.displayName}] handler error: ${err}`);
    }
  }
}
