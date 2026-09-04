/**
 * FounderOS — /jobs and /csv
 * ==========================
 * The two ways to SEE the shortlist. Both are read-only, both are zero-LLM, and
 * both exist because for two weeks there was no way to see it at all.
 *
 * WHAT WENT WRONG. The Telegram brief was switched off on 2026-08-06 in favour
 * of a Google Sheet, and the Sheet was never configured — `JOBHUNT_SHEET_ID` and
 * `GOOGLE_SHEETS_CREDENTIALS_PATH` were unset on prod through 2026-08-21, so
 * `exportJobSheet` returned "not set up" on all 48 sweeps a day. The ranking was
 * computed every half hour and discarded every half hour. `/draft` and
 * `/applied` were not invoked once in seven days of logs, which is what a
 * shortlist nobody can read looks like from the outside.
 *
 * The founder's call on 2026-08-21: drop the Sheet, "when i ask i want csv
 * directly". So the fix is two pull commands rather than one push integration —
 * nothing to create, nothing to authorise, nothing to keep working.
 *
 * WHY /jobs REBUILDS RATHER THAN READS. `buildDailyBrief` is what pins
 * `brief_section` and `brief_rank`, which is what `/draft N` resolves against.
 * Reading a stored rendering would hand the founder numbers that no longer point
 * at the rows they were computed for — the one failure mode worth more than the
 * seconds it costs to rank again.
 */

import { InputFile, type Context } from "grammy";
import { listApplyQueue, listRecentlyScreened } from "../db/apply-queries.js";
import {
  resolveProfileArg,
  isProfileArgMiss,
  profileMissMessage,
} from "./jobhunt-profile-arg.js";
import { DEFAULT_PROFILE_ID, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { buildQueueTab, buildLogTab } from "../tools/jobhunt/sheet-rows.js";
import { toCsv } from "../tools/jobhunt/csv-export.js";
import { childLogger } from "../infra/logger.js";
import { safeHtml } from "./approval-card.js";

const log = childLogger({ module: "gateway:jobhunt-view" });

/** Which file `/csv` builds. Bare `/csv` is the queue — the thing he acts on. */
export type CsvKind = "queue" | "log";

/**
 * Parse `/csv`, `/csv all`, `/csv log`.
 *
 * Anything unrecognised resolves to the queue rather than erroring. The cost of
 * guessing wrong is one extra file he ignores; the cost of a usage error is that
 * he types the command once, gets scolded, and never types it again.
 */
export function parseCsvKind(raw: string): CsvKind {
  return /^(all|log|everything|audit)$/i.test(raw.trim()) ? "log" : "queue";
}

/** `jobs-queue-2026-08-21.csv` — dated, so two downloads never collide in a file picker. */
export function csvFilename(kind: CsvKind, now: Date): string {
  return `jobs-${kind}-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * What to say above the file.
 *
 * Names the row count and what the rows ARE. A file arriving with no caption
 * makes the founder open it to find out whether it was worth opening.
 */
export function csvCaption(kind: CsvKind, rows: number): string {
  if (rows === 0) {
    return kind === "queue"
      ? "Your apply queue is empty right now — nothing has cleared screening in the last 24 hours."
      : "Nothing screened yet.";
  }
  return kind === "queue"
    ? `${rows} role(s) in your apply queue. The # column is the number /draft takes.`
    : `${rows} recently screened role(s), rejects included — the audit trail, not the shortlist.`;
}

export interface CsvPayload {
  readonly csv: string;
  readonly filename: string;
  readonly caption: string;
  readonly rows: number;
}

/**
 * Build the file. Separated from sending so the content is testable without a bot.
 *
 * Reuses `buildQueueTab`/`buildLogTab` rather than restating the columns: the
 * Sheet's column choices were made carefully and reviewed, and a second set of
 * headers would drift from them silently.
 */
export async function buildJobsCsv(
  kind: CsvKind,
  now: Date = new Date(),
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<CsvPayload> {
  const rows =
    kind === "queue"
      ? await listApplyQueue(undefined, profileId)
      : await listRecentlyScreened(undefined, profileId);
  const table = kind === "queue" ? buildQueueTab(rows, now) : buildLogTab(rows, now);
  return {
    csv: toCsv(table),
    filename: csvFilename(kind, now),
    caption: csvCaption(kind, rows.length),
    rows: rows.length,
  };
}

/** `/csv` — the apply queue as a file. `/csv all` — everything screened, rejects included. */
export async function handleCsv(ctx: Context): Promise<void> {
  // "all" is this command's own word for the log tab — reserved so it is never
  // read as a profile name.
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", ["all", "queue"]);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const kind = parseCsvKind(selected.rest);
  try {
    const payload = await buildJobsCsv(kind, new Date(), selected.profile.id);
    log.info({ kind, rows: payload.rows, profile: selected.profile.id }, "CSV export requested");
    await ctx.replyWithDocument(new InputFile(Buffer.from(payload.csv, "utf8"), payload.filename), {
      caption: payload.caption,
    });
  } catch (err) {
    // Never silent. A command that produces nothing reads as a broken bot, and
    // this one exists because the last export path failed quietly for two weeks.
    log.error({ kind, err: (err as Error).message }, "CSV export failed");
    await ctx.reply(`❌ Couldn't build the CSV: ${safeHtml((err as Error).message)}`, {
      parse_mode: "HTML",
    });
  }
}

export interface JobsViewDeps {
  /** Rebuilds the ranking and returns the rendered brief. Injected for testing. */
  readonly buildBrief: (profile: JobSearchProfile) => Promise<string>;
  /** Splits an HTML brief into Telegram-sized messages. */
  readonly split: (text: string) => string[];
}

/**
 * `/jobs` — rank the queue now and print it.
 *
 * The ranking is not cheap (it verifies the top rows are still open over the
 * network), so the founder is told it is running. A command that goes quiet for
 * twenty seconds is a command he assumes failed and retries, which runs the
 * whole thing twice.
 */
export async function handleJobs(ctx: Context, deps: JobsViewDeps): Promise<void> {
  const selected = resolveProfileArg(ctx.match?.toString() ?? "");
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const whose = selected.explicit ? `${selected.profile.candidateName}'s` : "your";
  await ctx.reply(`🔍 Ranking ${whose} queue and checking the top roles are still open…`);
  try {
    const brief = await deps.buildBrief(selected.profile);
    for (const chunk of deps.split(brief)) {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    }
  } catch (err) {
    log.error({ err: (err as Error).message }, "/jobs failed");
    await ctx.reply(
      `❌ Couldn't build the shortlist: ${safeHtml((err as Error).message)}\n\n` +
        `The screening results are still recorded — try /csv for the raw queue.`,
      { parse_mode: "HTML" },
    );
  }
}
