/**
 * .env loader that runs before any other module is imported.
 *
 * Many modules in this codebase capture `process.env.*` at module
 * initialization time (e.g. `qwen-persona.ts` for QWEN_PERSONA_DIR,
 * `claude-runner.ts` for CLAUDE_CWD, `mempalace-client.ts` for MEMPALACE_URL).
 * If `.env` parsing happens after those imports run, `.env`-only values are
 * never seen by the consuming module. Importing this file as the first
 * line of the entrypoint guarantees `.env` is parsed before any other
 * module-init code runs.
 *
 * No `dotenv` dependency — manual parser, same semantics as the previous
 * inline block in `src/index.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env is optional
}
