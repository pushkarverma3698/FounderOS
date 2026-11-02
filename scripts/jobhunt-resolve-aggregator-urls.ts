/**
 * Backfill `agents.job_applications.url` for Arbeitnow rows stored before ingest resolved them.
 *
 * Ingest now stores the employer's form (see src/tools/jobhunt/aggregator-apply-url.ts). Rows
 * written before that still hold Arbeitnow's own page, which has no form and which the VPS browser
 * cannot open, so Prepare can never work on them. This runs the same resolver over those rows.
 *
 * Only rows still open (not applied, not skipped). A posting that no longer redirects (closed,
 * 410) keeps its URL and is listed as unchanged. One request a second.
 *
 *   pnpm tsx scripts/jobhunt-resolve-aggregator-urls.ts            # dry run
 *   pnpm tsx scripts/jobhunt-resolve-aggregator-urls.ts --apply
 */

import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { isArbeitnowUrl, resolveEmployerApplyUrl } from "../src/tools/jobhunt/aggregator-apply-url.js";

const APPLY = process.argv.includes("--apply");
const PAUSE_MS = 1_000;

interface Row {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly url: string;
}

async function main(): Promise<void> {
  const result = (await db.execute(
    sql`select id, company, title, url from agents.job_applications
        where url ilike '%arbeitnow.%' and applied_at is null and skipped_at is null`,
  )) as unknown as { rows: Row[] };
  const rows = (result.rows ?? (result as unknown as Row[])).filter((r) => isArbeitnowUrl(r.url));
  if (rows.length === 0) {
    console.log("Nothing to resolve: no open Arbeitnow rows.");
    return;
  }

  let changed = 0;
  for (const [i, row] of rows.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const resolved = await resolveEmployerApplyUrl(row.url);
    if (resolved === row.url) {
      console.log(`  unchanged  ${row.id}  ${row.company} — ${row.title}`);
      continue;
    }
    console.log(`  resolved   ${row.id}  ${row.company} — ${row.title}\n             → ${resolved}`);
    if (APPLY) {
      await db.execute(sql`update agents.job_applications set url = ${resolved} where id = ${row.id}`);
    }
    changed += 1;
  }

  console.log(
    `\n${rows.length} open Arbeitnow row(s) · ${changed} resolved to the employer form · ` +
      `${rows.length - changed} unchanged (closed or no redirect)` +
      (APPLY ? "" : "\n\nDRY RUN — nothing written. Re-run with --apply."),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Resolve failed:", (err as Error).message);
    process.exit(1);
  });
