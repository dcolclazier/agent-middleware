// Smoke test for the issue #8 memory-offline warning, exercised against the
// REAL mempalace-client (not the in-memory channel-transcript test backend).
//
// MEMPALACE_URL is captured at module-load time inside mempalace-client, so
// the URL must be set in the environment BEFORE tsx imports the modules.
// Run: MEMPALACE_URL=http://127.0.0.1:1 npm run smoketest:mempalace-warning
//
// This script forces those values in process.env at the top before any
// channel-transcript / mempalace-client import, so it works without the
// caller setting them.

process.env.MEMPALACE_URL = "http://127.0.0.1:1"; // black-hole: always refused
process.env.MEMPALACE_TOKEN = "";
process.env.MEMPALACE_ENABLED = "true";

const {
  writeTurn,
  searchProse,
  setMemoryOfflineNotifier,
  _resetMemoryOfflineStateForTesting,
  MEMORY_OFFLINE_WARNING,
} = await import("../src/channel-transcript.js");

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

async function main() {
  _resetMemoryOfflineStateForTesting();

  const notifications: { channelId: string; message: string }[] = [];
  setMemoryOfflineNotifier((channelId, message) => {
    notifications.push({ channelId, message });
  });

  const channel = "outage-real-client";

  console.log(
    "\n--- real client + unreachable URL: first writeTurn fires warning ---",
  );
  await writeTurn(channel, "A", "first call", "2027-02-01T00:00:00Z");
  check(
    "first failure produced exactly one notification",
    notifications.length === 1,
    `actual=${notifications.length}`,
  );
  check(
    "notification carries canonical warning text",
    notifications[0]?.message === MEMORY_OFFLINE_WARNING,
  );
  check(
    "notification scoped to the failing channel",
    notifications[0]?.channelId === channel,
  );

  console.log(
    "\n--- second writeTurn during the same outage is suppressed ---",
  );
  await writeTurn(channel, "A", "second call", "2027-02-01T00:00:01Z");
  check(
    "second failure produced no additional notification",
    notifications.length === 1,
    `actual=${notifications.length}`,
  );

  console.log(
    "\n--- searchProse against same channel during outage also suppressed ---",
  );
  await searchProse("anything", channel, 3);
  check(
    "searchProse failure suppressed (flag still set)",
    notifications.length === 1,
    `actual=${notifications.length}`,
  );

  setMemoryOfflineNotifier(null);

  console.log(`\n======\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
