/**
 * Render the REAL brief from the live application table — $0, no network.
 *
 * `skipLiveness` keeps it free: no actor runs, no HTTP, no model call. What it
 * exercises is everything a unit test cannot — the actual rows in the actual
 * database, including every row screened before `gate_json` existed, which is
 * the case most likely to render badly and the one no fixture would catch.
 *
 * It DOES write: brief ranks and fit scores, exactly as the daily sweep does.
 * Run it against dev.
 *
 *   set -a && . ./.env && set +a && npx tsx scripts/jobhunt-brief-live.ts
 */

import { buildDailyBrief } from "../src/tools/jobhunt/daily-brief.js";
import { splitForTelegram } from "../src/tools/jobhunt/brief.js";

async function main(): Promise<void> {
  const brief = await buildDailyBrief({ skipLiveness: true });
  const parts = splitForTelegram(brief);

  console.log(brief);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${brief.length} chars · ${parts.length} Telegram message(s)`);
  parts.forEach((p, i) => console.log(`  part ${i + 1}: ${p.length} chars`));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Brief failed:", (err as Error).message);
  process.exit(1);
});
