// Unit tests for parseAttachmentSentinels — pure function, no Discord.
// Run: npx tsx scripts/test-sentinel-parser.ts

import { parseAttachmentSentinels } from "../src/bot-instance.js";

let failed = 0;
let passed = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function sect(name: string) {
  console.log(`\n--- ${name} ---`);
}

// -----------------------------------------------------------------------
// 1. No sentinels → cleanText unchanged, empty attachments
// -----------------------------------------------------------------------
sect("1. no sentinels");
{
  const input = "just a plain message with no attachments";
  const r = parseAttachmentSentinels(input);
  check("cleanText equals input", r.cleanText === input);
  check("zero attachments", r.attachments.length === 0);
  check("zero errors", r.errors.length === 0);
}

// -----------------------------------------------------------------------
// 2. Single valid sentinel → extracted, cleanText trimmed
// -----------------------------------------------------------------------
sect("2. single valid sentinel");
{
  const input = [
    "Here is the scene you asked for.",
    "",
    "[ATTACHMENT: scene_3.md]",
    "# Scene 3",
    "The goblin approached.",
    "[/ATTACHMENT]",
    "",
    "Let me know if you want edits.",
  ].join("\n");
  const r = parseAttachmentSentinels(input);
  check("one attachment", r.attachments.length === 1);
  check("filename correct", r.attachments[0]?.name === "scene_3.md");
  check(
    "content correct",
    r.attachments[0]?.content === "# Scene 3\nThe goblin approached.",
    `got: ${JSON.stringify(r.attachments[0]?.content)}`,
  );
  check("prose preserved before", r.cleanText.includes("Here is the scene"));
  check("prose preserved after", r.cleanText.includes("Let me know if you want edits."));
  check("sentinel stripped from cleanText", !r.cleanText.includes("[ATTACHMENT:"));
  check("no errors", r.errors.length === 0);
}

// -----------------------------------------------------------------------
// 3. Multiple sentinels → all extracted in order
// -----------------------------------------------------------------------
sect("3. multiple sentinels");
{
  const input = [
    "Two files coming up.",
    "",
    "[ATTACHMENT: a.md]",
    "first",
    "[/ATTACHMENT]",
    "",
    "And the second:",
    "",
    "[ATTACHMENT: b.txt]",
    "second",
    "[/ATTACHMENT]",
    "",
    "Done.",
  ].join("\n");
  const r = parseAttachmentSentinels(input);
  check("two attachments", r.attachments.length === 2);
  check("order preserved [0]", r.attachments[0]?.name === "a.md");
  check("order preserved [1]", r.attachments[1]?.name === "b.txt");
  check("content [0]", r.attachments[0]?.content === "first");
  check("content [1]", r.attachments[1]?.content === "second");
  check("no errors", r.errors.length === 0);
}

// -----------------------------------------------------------------------
// 4. Sentinel inside fenced code block → ignored, left in cleanText
// -----------------------------------------------------------------------
sect("4. sentinel inside fenced code block");
{
  const input = [
    "Here's how the format works:",
    "",
    "```",
    "[ATTACHMENT: example.md]",
    "example content",
    "[/ATTACHMENT]",
    "```",
    "",
    "Got it?",
  ].join("\n");
  const r = parseAttachmentSentinels(input);
  check("no attachments extracted", r.attachments.length === 0);
  check("sentinel still visible in cleanText", r.cleanText.includes("[ATTACHMENT: example.md]"));
  check(
    "code block markers still present",
    r.cleanText.includes("```"),
  );
  check("no errors", r.errors.length === 0);
}

// -----------------------------------------------------------------------
// 5. Sentinel spanning many lines with markdown inside
// -----------------------------------------------------------------------
sect("5. multi-line content with markdown");
{
  const content = "# Heading\n\n- bullet 1\n- bullet 2\n\n```ts\nconst x = 1;\n```\n\nText.";
  const input = [
    "See attached.",
    "",
    "[ATTACHMENT: doc.md]",
    content,
    "[/ATTACHMENT]",
  ].join("\n");
  const r = parseAttachmentSentinels(input);
  check("one attachment", r.attachments.length === 1);
  check(
    "content extracted verbatim",
    r.attachments[0]?.content === content,
    `got: ${JSON.stringify(r.attachments[0]?.content)}`,
  );
}

// -----------------------------------------------------------------------
// 6. Malformed sentinel (unclosed) → left as-is, no error
// -----------------------------------------------------------------------
sect("6. malformed unclosed sentinel");
{
  const input = "Text before\n\n[ATTACHMENT: broken.md]\nnever closed\n\nText after";
  const r = parseAttachmentSentinels(input);
  check("no attachments", r.attachments.length === 0);
  check("no errors (silent skip)", r.errors.length === 0);
  check("original text preserved", r.cleanText.includes("[ATTACHMENT: broken.md]"));
}

// -----------------------------------------------------------------------
// 7. Invalid filename (traversal) → error, sentinel left in cleanText
// -----------------------------------------------------------------------
sect("7. traversal filename");
{
  const input = [
    "Evil attempt:",
    "",
    "[ATTACHMENT: ../../etc/passwd]",
    "root:x:0:0:",
    "[/ATTACHMENT]",
  ].join("\n");
  const r = parseAttachmentSentinels(input);
  check("no attachments extracted", r.attachments.length === 0);
  check("error recorded", r.errors.length === 1);
  check("sentinel left in cleanText", r.cleanText.includes("[ATTACHMENT: ../../etc/passwd]"));
}

// -----------------------------------------------------------------------
// 8. Extension not in allowlist → error
// -----------------------------------------------------------------------
sect("8. disallowed extension");
{
  const input = [
    "[ATTACHMENT: evil.exe]",
    "binary",
    "[/ATTACHMENT]",
  ].join("\n");
  const r = parseAttachmentSentinels(input);
  check("no attachments", r.attachments.length === 0);
  check("error recorded", r.errors.length === 1);
  check("error mentions extension", r.errors[0]?.includes("extension"));
}

// -----------------------------------------------------------------------
// 9. Oversized file → dropped with error
// -----------------------------------------------------------------------
sect("9. oversized single file");
{
  const huge = "a".repeat(11_000_000); // 11MB > 10MB cap
  const input = `[ATTACHMENT: big.md]\n${huge}\n[/ATTACHMENT]`;
  const r = parseAttachmentSentinels(input);
  check("no attachments", r.attachments.length === 0);
  check("error recorded", r.errors.length === 1);
  check("sentinel left in cleanText", r.cleanText.includes("[ATTACHMENT: big.md]"));
}

// -----------------------------------------------------------------------
// 10. Total oversized → tail files dropped, prose kept
// -----------------------------------------------------------------------
sect("10. total oversized — drop tail");
{
  const chunk = "a".repeat(4_000_000); // 4MB each
  const input = [
    "Three files",
    `[ATTACHMENT: a.md]\n${chunk}\n[/ATTACHMENT]`,
    `[ATTACHMENT: b.md]\n${chunk}\n[/ATTACHMENT]`,
    `[ATTACHMENT: c.md]\n${chunk}\n[/ATTACHMENT]`,
  ].join("\n\n");
  const r = parseAttachmentSentinels(input);
  check("prose preserved", r.cleanText.includes("Three files"));
  check("some attachments kept", r.attachments.length >= 1);
  check("at least one dropped", r.attachments.length < 3);
  check("drop errors recorded", r.errors.length >= 1);
  // First two (8MB) fit, third (12MB total) pushes over → dropped.
  check("first attachment kept", r.attachments[0]?.name === "a.md");
}

// -----------------------------------------------------------------------
// 11. Sentinel with no surrounding prose → cleanText empty
// -----------------------------------------------------------------------
sect("11. sentinel only, no prose");
{
  const input = "[ATTACHMENT: only.md]\njust the file\n[/ATTACHMENT]";
  const r = parseAttachmentSentinels(input);
  check("one attachment", r.attachments.length === 1);
  check(
    "cleanText empty after trim",
    r.cleanText === "",
    `got: ${JSON.stringify(r.cleanText)}`,
  );
}

// -----------------------------------------------------------------------
// 12. 5-file cap
// -----------------------------------------------------------------------
sect("12. more than 5 attachments");
{
  const parts: string[] = ["Many files"];
  for (let i = 0; i < 7; i++) {
    parts.push(`[ATTACHMENT: file${i}.md]\ncontent ${i}\n[/ATTACHMENT]`);
  }
  const input = parts.join("\n\n");
  const r = parseAttachmentSentinels(input);
  check("capped at 5", r.attachments.length === 5);
  check("drop errors recorded", r.errors.length === 2);
  // Files dropped are the tail (file5, file6).
  check("first 5 kept in order", r.attachments[0]?.name === "file0.md");
  check("last kept is file4", r.attachments[4]?.name === "file4.md");
}

// -----------------------------------------------------------------------
console.log(`\n======\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
