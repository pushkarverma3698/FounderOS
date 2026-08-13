/**
 * require-env.ts
 * ===============
 * Fail-fast env guard for `pnpm brain:sync` (scripts/sync-turicks-brain.ts).
 *
 * Until 2026-08-12 the npm script ran `node --env-file=.env …`. When `.env`
 * itself was missing (e.g. a fresh container) Node aborted with a bare
 * `node: .env: not found` before a single line of our own code ran — no
 * mention of which file, no mention of what to do. When `.env` existed but
 * `DATABASE_URL` was unset inside it, the eager `envSchema.parse` in
 * src/core/config.ts (src/core/config.ts:220) threw its own message — accurate,
 * but reached only through a stack of "Fatal:" wrapping from main()'s catch
 * (scripts/sync-turicks-brain.ts:578-581) and never distinguishing "no .env"
 * from "env present, var unset".
 *
 * This module produces one plain, actionable line for each of those two
 * distinct causes and exits before any other import in the chain (notably
 * ../src/db/client.js → ../src/core/config.js, whose top-level
 * `envSchema.parse` throws the opaque error) gets a chance to run.
 *
 * MUST be the first import in any script that needs it — ES module imports
 * are evaluated in declaration order, and an importing module's own
 * top-level code (including further imports listed after this one) never
 * runs until every import ahead of it has fully evaluated. Verified
 * empirically (see PR body) before relying on it here.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Pure — used by the exit paths below and covered directly by unit tests. */
export function missingEnvFileMessage(envPath: string): string {
  return (
    `brain:sync: ${envPath} not found.\n` +
    `  Fix: cp .env.example .env   (then fill in DATABASE_URL — see .env.example, ` +
    `or ask the founder for the real prod value).`
  );
}

/** Pure — used by the exit paths below and covered directly by unit tests. */
export function missingVarMessage(varName: string): string {
  return (
    `brain:sync: required env var ${varName} is not set.\n` +
    `  Fix: add ${varName}=… to .env (see .env.example for the format; ` +
    `ask the founder for the real value — never commit it).`
  );
}

// CLI-only guard — same pattern as the main()-invocation guard at the bottom of
// sync-turicks-brain.ts. process.argv[1] is set once at process start to the
// entry script and reads the same regardless of which module inspects it, so
// this correctly no-ops when the test suite imports sync-turicks-brain.ts for
// its pure helpers (tests/unit/scripts/sync-turicks-brain.test.ts) — those runs
// already get DATABASE_URL from tests/setup.ts, not from a .env file on disk.
if (process.argv[1]?.endsWith("sync-turicks-brain.ts")) {
  const envPath = resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    console.error(missingEnvFileMessage(envPath));
    process.exit(1);
  }

  // Node 22.9+ built-in — same mechanism `node --env-file` used, but invoked
  // from our own code so a missing/unset var can be reported by name instead
  // of a bare CLI error or an opaque downstream zod throw.
  process.loadEnvFile(envPath);

  if (!process.env["DATABASE_URL"]) {
    console.error(missingVarMessage("DATABASE_URL"));
    process.exit(1);
  }
}
