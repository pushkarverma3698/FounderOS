/**
 * Backfill `agents.job_applications.track` for rows screened before tracks existed.
 *
 * WHY THIS IS NEEDED. Production ran `a966e9a` (PR #394, the screening gates)
 * until 2026-08-01. That code had no track classifier, so every row it wrote
 * took the column's default, `"unclassified"`. The brief ranks a row by comparing
 * the posting against ITS TRACK'S CV — and an unclassified row matched no CV, so
 * it scored 0 overlap. The first real brief showed "0/21 skills", "0/13 skills",
 * "0/15 skills" on three genuinely well-matched roles, and the ordering those
 * numbers implied was meaningless.
 *
 * WHY A SCRIPT AND NOT SQL. `classifyTrack` is pure, deterministic and already
 * unit-tested. Re-expressing its phrase list as a pile of SQL `LIKE`s would
 * create a second classifier that drifts from the first, and the drift would be
 * invisible — both would keep returning confident answers.
 *
 * Idempotent: only touches rows still sitting at "unclassified", and only when
 * the title actually classifies. A title that genuinely matches no track stays
 * unclassified, which is the honest answer, and the brief now says so out loud.
 *
 *   pnpm tsx scripts/jobhunt-backfill-tracks.ts --dry-run
 *   pnpm tsx scripts/jobhunt-backfill-tracks.ts --apply
 */

import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { classifyTrack } from "../src/tools/jobhunt/tracks.js";

const APPLY = process.argv.includes("--apply");

interface Row {
  readonly id: string;
  readonly company: string;
  readonly title: string;
}

async function main(): Promise<void> {
  const rows = (await db.execute(
    sql`select id, company, title from agents.job_applications where track = 'unclassified'`,
  )) as unknown as { rows: Row[] };

  const candidates = rows.rows ?? (rows as unknown as Row[]);
  if (candidates.length === 0) {
    console.log("Nothing to backfill — no rows sitting at 'unclassified'.");
    return;
  }

  let changed = 0;
  let stillUnclassified = 0;

  for (const row of candidates) {
    const track = classifyTrack(row.title);
    if (track === null) {
      stillUnclassified += 1;
      console.log(`  keep unclassified  ${row.company} — ${row.title}`);
      continue;
    }
    console.log(`  ${track.padEnd(10)}       ${row.company} — ${row.title}`);
    if (APPLY) {
      await db.execute(
        sql`update agents.job_applications set track = ${track} where id = ${row.id}`,
      );
    }
    changed += 1;
  }

  console.log(
    `\n${candidates.length} untracked row(s) · ${changed} classified · ` +
      `${stillUnclassified} genuinely match no track` +
      (APPLY ? "" : "\n\nDRY RUN — nothing written. Re-run with --apply."),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Backfill failed:", (err as Error).message);
    process.exit(1);
  });
