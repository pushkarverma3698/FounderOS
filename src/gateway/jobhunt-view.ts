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
import { resolveProfileArg, isProfileArgMiss } from "./jobhunt-profile-arg.js";
import {
  DEFAULT_PROFILE_ID,
  getProfile,
  type JobSearchProfile,
} from "../tools/jobhunt/profile-config.js";
import {
  isProfileMiss,
  parseBriefRequest,
  profileMissMessage,
  scopeFor,
  type BriefScopePlan,
  type BriefVerb,
} from "../tools/jobhunt/brief-resolver.js";
import { buildQueueTab, buildLogTab } from "../tools/jobhunt/sheet-rows.js";
import { toCsv } from "../tools/jobhunt/csv-export.js";
import { inScope } from "../tools/jobhunt/brief-queue.js";
import { refreshLiveness } from "../tools/jobhunt/liveness-refresh.js";
import { lastFreshView } from "../db/job-heartbeat-queries.js";
import { childLogger } from "../infra/logger.js";
import { safeHtml } from "./approval-card.js";

const log = childLogger({ module: "gateway:jobhunt-view" });

/** Which file `/csv` builds. Bare `/csv` is the queue — the thing he acts on. */
export type CsvKind = "queue" | "log";

/** The slice of the queue a file covers. Same shape `inScope` filters against. */
export type CsvScope = Pick<BriefScopePlan, "windowHours" | "since" | "axis">;

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

/**
 * Which verb `/csv <rest>` is asking for, if any.
 *
 * ADDED 2026-09-09. `/csv` knew two words — "queue" and "all" — while `/jobs`,
 * `/today` and `/fresh` had a full resolver behind them. So the founder could
 * ask for today's roles on screen and not in a file, which is backwards: the
 * file is what he wants precisely when the screen cannot hold the answer.
 */
export function parseCsvVerb(raw: string): BriefVerb | null {
  const word = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (word === "today") return "today";
  if (word === "fresh" || word === "new") return "fresh";
  return null;
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
export function csvCaption(kind: CsvKind, rows: number, verification?: VerificationNote): string {
  if (rows === 0) {
    return kind === "queue"
      ? "Your apply queue is empty right now — nothing has cleared screening in the last 24 hours."
      : "Nothing screened yet.";
  }
  const noun = rows === 1 ? "role" : "roles";
  const head =
    kind === "queue"
      ? `${rows} ${noun} in your apply queue. The # column is the number /draft takes.`
      : `${rows} screened ${noun}, rejects included — the audit trail, not the shortlist.`;
  return verification ? `${head}\n${describeVerification(verification)}` : head;
}

/** What `refreshLiveness` did, reduced to the three numbers a caption needs. */
export interface VerificationNote {
  readonly verified: number;
  readonly skipped: number;
  readonly alreadyFresh: number;
}

/**
 * One line saying which links were actually checked.
 *
 * NAMES THE UNCHECKED COUNT. A file that verified 150 of 1,700 links and said
 * only "150 verified" reads as a complete file — which is the same defect as
 * the silent 100-row brief cap, one layer down. The skipped number is the one
 * that changes what the founder trusts, so it is never omitted when non-zero.
 */
export function describeVerification(note: VerificationNote): string {
  const current = note.verified + note.alreadyFresh;
  const base = `🔗 ${current} link(s) confirmed against the employer's site (${note.verified} re-checked just now).`;
  return note.skipped > 0
    ? `${base} ${note.skipped} were past this file's check budget and show their last known state.`
    : base;
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
  opts: { scope?: CsvScope; skipLiveness?: boolean } = {},
): Promise<CsvPayload> {
  const all =
    kind === "queue"
      ? await listApplyQueue(undefined, profileId)
      : await listRecentlyScreened(undefined, profileId);

  // FILTERED BEFORE VERIFYING, deliberately. The check budget belongs to rows
  // that will be in the file; spending it on rows the scope excludes is how a
  // `/csv today` ends up with an unverified today.
  const scoped = opts.scope ? all.filter((row) => inScope(row, opts.scope!, now)) : all;

  const refreshed = opts.skipLiveness
    ? { rows: scoped, verified: 0, skipped: 0, alreadyFresh: 0 }
    : await refreshLiveness(scoped, { now });

  const table =
    kind === "queue" ? buildQueueTab(refreshed.rows, now) : buildLogTab(refreshed.rows, now);
  return {
    csv: toCsv(table),
    filename: csvFilename(kind, now),
    caption: csvCaption(kind, refreshed.rows.length, opts.skipLiveness ? undefined : refreshed),
    rows: refreshed.rows.length,
  };
}

/**
 * `/csv` — the apply queue as a file. `/csv all` — everything screened.
 * `/csv today`, `/csv fresh`, `/csv wife 7d` — the same slices the screen verbs show.
 *
 * A VERB IMPLIES THE LOG, not the queue. "Everything I found today" must include
 * the rows the ranking did not pin, or the file answers a narrower question than
 * the one asked and looks like an empty market.
 */
export async function handleCsv(ctx: Context): Promise<void> {
  // "all" is this command's own word for the log tab — reserved so it is never
  // read as a profile name.
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", ["all", "queue", "today", "fresh", "new"]);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const verb = parseCsvVerb(selected.rest);
  const kind = verb ? "log" : parseCsvKind(selected.rest);
  try {
    const request = parseBriefRequest(selected.rest, verb ?? "jobs");
    const scope = isProfileMiss(request)
      ? undefined
      : scopeFor(request, {
          lastFreshView: request.verb === "fresh" ? await lastFreshView(selected.profile.id) : null,
        });
    const payload = await buildJobsCsv(kind, new Date(), selected.profile.id, { ...(scope ? { scope } : {}) });
    log.info(
      { kind, verb, rows: payload.rows, profile: selected.profile.id },
      "CSV export requested",
    );
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
  readonly buildBrief: (profile: JobSearchProfile, scope: BriefScopePlan) => Promise<string>;
  /** Splits an HTML brief into Telegram-sized messages. */
  readonly split: (text: string) => string[];
  /** When the founder last ran `/fresh` for this candidate — `/fresh`'s delta marker. */
  readonly lastFreshView: (profileId: string) => Promise<Date | null>;
  /** Stamp "seen up to here". Called only after a `/fresh` actually rendered. */
  readonly recordFreshView: (profileId: string, at: Date) => Promise<void>;
}

/** What the founder is told is happening, per verb, while the ranking runs. */
const RUNNING_LINE: Record<BriefVerb, string> = {
  jobs: "Ranking %s queue and checking the top roles are still open…",
  today: "Finding what employers published in %s market in the last 24h…",
  fresh: "Finding what has arrived in %s queue since you last looked…",
};

/**
 * `/jobs`, `/today`, `/fresh` — one handler, because they are one query.
 *
 * THE THREE VERBS DIFFER ONLY IN WHICH SLICE THEY PRINT. They rank the same
 * population, share one `brief_rank` numbering, and reach it through the same
 * `parseBriefRequest` the English surface uses (brief-tool.ts). Three handlers
 * would be three chances for `/today` and "roles posted today" to disagree —
 * and nothing would tell the founder which of them was lying.
 *
 * The ranking is not cheap (it verifies the top rows are still open over the
 * network), so the founder is told it is running. A command that goes quiet for
 * twenty seconds is a command he assumes failed and retries, which runs the
 * whole thing twice.
 */
export async function handleBriefVerb(
  ctx: Context,
  verb: BriefVerb,
  deps: JobsViewDeps,
): Promise<void> {
  const request = parseBriefRequest(ctx.match?.toString() ?? "", verb);
  if (isProfileMiss(request)) {
    await ctx.reply(profileMissMessage(request));
    return;
  }

  const profile = getProfile(request.profileId);
  const whose = request.explicitProfile ? `${profile.candidateName}'s` : "your";
  await ctx.reply(`🔍 ${(RUNNING_LINE[verb] as string).replace("%s", whose)}`);

  const now = new Date();
  try {
    const scope = scopeFor(request, {
      lastFreshView: verb === "fresh" ? await deps.lastFreshView(profile.id) : null,
    });
    const brief = await deps.buildBrief(profile, scope);
    for (const chunk of deps.split(brief)) {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    }
    // AFTER the send, not before. A marker written ahead of a failed render
    // would mean those rows are "seen" and never appear under `/fresh` again —
    // a silent, permanent loss for the one command whose whole job is to show
    // what has not been seen.
    if (verb === "fresh") {
      try {
        await deps.recordFreshView(profile.id, now);
      } catch (err) {
        // allow-failopen: the list already reached him. A lost marker repeats
        // these rows next time, which is visible and costs nothing.
        log.warn({ err: (err as Error).message, profile: profile.id }, "Fresh-view marker not written");
      }
    }
  } catch (err) {
    log.error({ err: (err as Error).message, verb }, `/${verb} failed`);
    await ctx.reply(
      `❌ Couldn't build the shortlist: ${safeHtml((err as Error).message)}\n\n` +
        `The screening results are still recorded — try /csv for the raw queue.`,
      { parse_mode: "HTML" },
    );
  }
}

/** `/jobs [who] [range]` — everything on file, freshest first. */
export async function handleJobs(ctx: Context, deps: JobsViewDeps): Promise<void> {
  await handleBriefVerb(ctx, "jobs", deps);
}

/** `/today [who]` — only what an employer published in the last 24h. */
export async function handleToday(ctx: Context, deps: JobsViewDeps): Promise<void> {
  await handleBriefVerb(ctx, "today", deps);
}

/** `/fresh [who]` — only what we discovered since the founder last asked. */
export async function handleFresh(ctx: Context, deps: JobsViewDeps): Promise<void> {
  await handleBriefVerb(ctx, "fresh", deps);
}
