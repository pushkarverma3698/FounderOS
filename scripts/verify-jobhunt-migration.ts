/**
 * $0 check that migration 0022 actually landed: `gate_json` on job_applications
 * and the `job_ingest_runs` ledger table.
 *
 * Exists because a drizzle migration is INERT unless its `_journal.json` entry
 * is present, and the failure mode is silent: the app keeps running against the
 * old schema and only the new writes fail, one at a time, inside fail-open
 * catches that log a warning nobody reads. This is the cheapest way to know the
 * schema is what the code thinks it is.
 *
 *   set -a && . ./.env && set +a && npx tsx scripts/verify-jobhunt-migration.ts
 */

import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";

/** postgres-js returns an array; node-postgres returns `{ rows }`. Handle both. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const withRows = result as { rows?: Record<string, unknown>[] };
  return withRows.rows ?? [];
}

async function main(): Promise<void> {
  const db = getDb();
  let ok = true;

  const cols = rowsOf(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'agents' AND table_name = 'job_applications'
        AND column_name IN ('gate_json', 'fit_score', 'fit_evidence')
      ORDER BY column_name`),
  ).map((c) => String(c["column_name"]));

  for (const expected of ["fit_evidence", "fit_score", "gate_json"]) {
    const present = cols.includes(expected);
    if (!present) ok = false;
    console.log(`${present ? "✓" : "✗"} job_applications.${expected}`);
  }

  const runCols = rowsOf(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'agents' AND table_name = 'job_ingest_runs'
      ORDER BY ordinal_position`),
  ).map((c) => String(c["column_name"]));

  if (runCols.length === 0) {
    ok = false;
    console.log("✗ agents.job_ingest_runs — TABLE MISSING");
  } else {
    console.log(`✓ agents.job_ingest_runs (${runCols.length} cols): ${runCols.join(", ")}`);
  }

  const counts = rowsOf(
    await db.execute(sql`
      SELECT count(*)::int AS total,
             count(gate_json)::int AS with_gates
      FROM agents.job_applications`),
  )[0];
  console.log(
    `\nRows: ${counts?.["total"] ?? 0} total, ${counts?.["with_gates"] ?? 0} carrying a gate record.\n` +
      `Rows without one are read back through the legacy parser and reported as ` +
      `"we cannot say which check passed" — never as passing.`,
  );

  console.log(ok ? "\nSchema OK." : "\nSCHEMA INCOMPLETE — run `npx tsx scripts/setup-db.ts`.");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("Verification failed:", (err as Error).message);
  process.exit(1);
});
