// Quick smoke test for qwen-memory.remember() and list() after the fix.
// Run: npx tsx scripts/test-remember.ts
import { remember, list } from "../src/qwen-memory.js";

const channel = "smoke-test-channel";

async function main() {
  console.log("[test] calling remember(naming, 'Kaelen is the protagonist')");
  await remember(channel, "naming", "Kaelen is the protagonist of hackers_shift arc 1");

  console.log("[test] calling remember(user_preference, 'user prefers clinical tone')");
  await remember(channel, "user_preference", "user prefers clinical tone for canon prose");

  console.log("[test] calling list(channel, no query, 10)");
  const recent = await list(channel, undefined, 10);
  console.log(`[test] recent: ${recent.length} rows`);
  for (const r of recent) {
    console.log(`  - ${r.id.slice(0, 8)} [${r.fact_type}] ${r.content.slice(0, 60)}`);
  }

  console.log("[test] calling list(channel, 'who is the protagonist', 3)");
  const semantic = await list(channel, "who is the protagonist", 3);
  console.log(`[test] semantic: ${semantic.length} rows`);
  for (const r of semantic) {
    console.log(`  - sim=${r.similarity?.toFixed(3)} ${r.content.slice(0, 60)}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
