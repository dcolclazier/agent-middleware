// --- Channel slash-command parser ---
//
// Recognises the `/btw | /cancel | /end` family as the FIRST non-whitespace
// token of a Discord channel message body (after BotInstance has stripped
// proper @-mentions and the textMentionPattern). Returns null for prose,
// unknown verbs, or messages where the verb appears mid-sentence rather
// than at the start.
//
// Why first-token only? The brief is explicit: "prose like '/end of file
// is needed' is NOT triggered as a command." More precisely, "I want to
// /cancel my subscription" must NOT trigger /cancel, because the verb is
// not the first token. "/end of file is needed" DOES trigger /end (verb
// is first; payload is "of file is needed") — `/end`'s caller is
// responsible for ignoring the payload per the brief.
//
// Word-boundary check: `/cancelling now` is NOT `/cancel` — the verb must
// be followed by whitespace, end-of-string, or punctuation, never another
// letter that would make it a different word.
//
// This module is pure / no Discord, no I/O. Test coverage:
// `scripts/test-slash-commands.ts`. CONTEXT.md → /btw, /cancel, /end.
//
// Slice 1 (issue #14) wires /cancel and /end. /btw is recognised here so
// Slice 2 (issue #15) doesn't have to revisit the parser.

export type SlashVerb = "/btw" | "/cancel" | "/end";

export interface SlashCommand {
  verb: SlashVerb;
  /** Everything after the verb, leading/trailing whitespace stripped, internal whitespace collapsed to single spaces. */
  payload: string;
}

const KNOWN_VERBS: ReadonlySet<string> = new Set(["/btw", "/cancel", "/end"]);

// Match: optional leading whitespace, the verb (alphabetic only after the
// slash), then either end-of-string OR a single non-word boundary char
// (\W = anything not [A-Za-z0-9_]) which IS consumed so it doesn't leak
// into the payload.
//
// Why \W (not [^a-z]) for the boundary: the looser form treats digits and
// underscore as boundaries, which would parse `/end2end` as `/end` with
// payload `end` (verb capture stops at `2`, then `[^a-z]` consumes the
// `2`) — accidentally triggering /end and clearing the channel mapping.
// \W requires a real word break (whitespace, punctuation, end-of-string),
// so identifier-shaped tokens like `/end2`, `/cancel_foo`, `/end2end`
// fail to match this regex outright and parseSlashCommand returns null.
//
// Capture group 1 = verb (lowercased before lookup).
// Capture group 2 = the rest of the message AFTER the consumed boundary
// (the boundary char itself is NOT in group 2). If the verb ended the
// string, the alternation hits `$` (zero-width) and group 2 is empty.
const SLASH_CMD_RE = /^\s*(\/[a-z]+)(?:$|\W)([\s\S]*)$/i;

/**
 * Parse a channel message body for a slash-command verb.
 *
 * Input is expected to be the post-mention-strip, trimmed body that
 * BotInstance.handleMessage produces before delegating to the harness
 * handler. We tolerate leading whitespace defensively in case a future
 * caller forgets to trim.
 *
 * Returns `null` for: empty input, prose without a leading slash verb,
 * unknown slash verbs (e.g. `/foo`), or `/cancelling`-style words that
 * have a known verb as a prefix but aren't actually that verb.
 */
export function parseSlashCommand(content: string): SlashCommand | null {
  if (typeof content !== "string" || content.trim().length === 0) return null;

  const m = SLASH_CMD_RE.exec(content);
  if (!m) return null;

  const verb = (m[1] ?? "").toLowerCase();
  if (!KNOWN_VERBS.has(verb)) return null;

  // Group 2 is everything AFTER the boundary char (which the regex
  // consumed). Collapse runs of internal whitespace and trim so the
  // payload is normalized — e.g. `/btw    what    now` → "what now".
  const rawPayload = m[2] ?? "";
  const payload = rawPayload.replace(/\s+/g, " ").trim();

  return { verb: verb as SlashVerb, payload };
}
