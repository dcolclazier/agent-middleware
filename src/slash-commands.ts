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
  /**
   * Everything after the verb, with leading separators (whitespace and the
   * common verb→payload punctuation `:` `,` `;` `.`) and trailing whitespace
   * stripped. Internal whitespace (including newlines) is preserved verbatim
   * so multi-line `/btw` payloads keep their formatting.
   */
  payload: string;
}

const KNOWN_VERBS: ReadonlySet<string> = new Set(["/btw", "/cancel", "/end"]);

// Match: optional leading whitespace, the verb (lowercase letters only after
// the slash), then either end-of-string OR a non-alphanumeric, non-underscore
// character (whitespace, punctuation, etc.). The boundary class
// `[^a-z0-9_]` excludes digits and underscores so inputs like `/end2` or
// `/cancel_all` are NOT silently parsed as `/end` / `/cancel` with a
// digit/underscore-prefixed payload — adding a new verb that includes
// digits or underscores requires an explicit parser update rather than a
// silent match.
//
// Capture group 1 = verb (lowercased before lookup).
// Capture group 2 = the rest of the message AFTER the verb's trailing
// boundary character. If the verb ended the string, group 2 is empty.
const SLASH_CMD_RE = /^\s*(\/[a-z]+)(?=$|[^a-z0-9_])([\s\S]*)$/i;

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

  // Everything after the verb's word-boundary char. The boundary char itself
  // (whitespace or punctuation) lives in group 2's leading position. We strip
  // leading separators — whitespace plus the common verb→payload punctuation
  // `:` `,` `;` `.` — so `/btw: question` and `/btw, question` both yield
  // payload `"question"` instead of `": question"`. Internal whitespace
  // (including newlines) is preserved verbatim so multi-line `/btw` payloads
  // keep their formatting (collapsing newlines would silently destroy
  // structure in code blocks, lists, etc.). Trailing whitespace is trimmed.
  const rawPayload = m[2] ?? "";
  const payload = rawPayload.replace(/^[\s:.,;]+/, "").trimEnd();

  return { verb: verb as SlashVerb, payload };
}
