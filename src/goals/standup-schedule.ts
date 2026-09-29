/**
 * FounderOS — goals: when the standup runs
 * ========================================
 *   the cron      09:00 in the app timezone (`{ timezone: appTimeZone() }`; the other crons pass none and are
 *                 left alone in this change)
 *   boot catch-up node-cron does not catch up, so a deploy restart at 09:00 would skip the day. At boot, if
 *                 it is between 09:00 and 21:00 local and no goal has a SENT review for today's local date,
 *                 the same idempotent function runs once
 *   retry         a bounded loop around the function, so a run that died between claim and send is recovered
 *                 by the next run without waiting a day: an in-flight lease is waited out, a failed send is
 *                 retried after the lease, an unexpected error after a short pause. After
 *                 RETRY_MAX_ATTEMPTS the founder is told, with the reason and the fix.
 *
 * Everything here decides WHEN. What the standup does is standup.ts; how it reaches Telegram and Postgres is
 * standup-deps.ts, imported lazily so `startScheduler()` stays light and unit-testable.
 */

import cron from "node-cron";
import { appTimeZone } from "../core/time.js";
import { childLogger } from "../infra/logger.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { formatDayLabel, localDateKey, localMinutesOfDay } from "./local-date.js";
import { describeSendError, runStandup, type StandupDeps, type StandupLog, type StandupOutcome } from "./standup.js";

/** 09:00 every day; the timezone is passed alongside it, never assumed. */
export const STANDUP_CRON = "0 9 * * *";
/** The standup is due from 09:00 local... */
export const STANDUP_START_MINUTE = 9 * 60;
/** ...until 21:00 local; a standup at night is noise and tomorrow's is coming. */
export const STANDUP_CUTOFF_MINUTE = 21 * 60;
/** Attempts before the founder is told the standup could not be sent. */
export const RETRY_MAX_ATTEMPTS = 3;
/** Pause before retrying after an unexpected error (a database that is down). */
export const RETRY_MIN_DELAY_MS = 30_000;

export interface RetryDeps {
  sleep(ms: number): Promise<void>;
}
const REAL_RETRY: RetryDeps = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** An outcome, or `failed` when the run threw. */
export type RunResult = StandupOutcome | { readonly kind: "failed"; readonly error: string };

const defaultLog = childLogger({ module: "goals-standup" });

async function defaultMakeDeps(): Promise<StandupDeps> {
  return (await import("./standup-deps.js")).createStandupDeps();
}

/** Is `now` between 09:00 and 21:00 in `timeZone`? */
export function isWithinStandupWindow(now: Date, timeZone: string): boolean {
  const minute = localMinutesOfDay(now, timeZone);
  return minute >= STANDUP_START_MINUTE && minute < STANDUP_CUTOFF_MINUTE;
}

/** How long to wait before running again, or null when the outcome cannot improve. */
function retryDelayMs(result: RunResult): number | null {
  switch (result.kind) {
    case "in-progress":
    case "send-failed":
      return result.retryAfterMs;
    case "sent":
      return result.retryAfterMs; // null unless another live run still held some goals
    case "failed":
      return RETRY_MIN_DELAY_MS;
    default:
      return null; // nothing-due, already-sent, halted, dry-run
  }
}

async function alertFailure(deps: StandupDeps, last: RunResult): Promise<void> {
  const reason =
    last.kind === "in-progress"
      ? "another run is still holding today's standup and its claim has not expired"
      : last.kind === "send-failed" || last.kind === "failed"
        ? last.error
        : last.kind;
  const text =
    `⚠️ <b>Goal standup for ${formatDayLabel(localDateKey(deps.now(), deps.timeZone))} could not be sent</b>\n` +
    `Reason: ${esc(reason)}\n` +
    `Tried ${RETRY_MAX_ATTEMPTS} times. Once the cause is fixed, run <code>pnpm goals:standup --now</code> on the server; it never sends a goal twice.`;
  try {
    await deps.send({ text, keyboard: [] });
  } catch (err) {
    // allow-failopen: this alert IS the last resort. If Telegram is what is broken it cannot be delivered, and the error line below is the record.
    deps.log.error({ component: "goals-standup", error: describeSendError(err) }, "Goal standup: could not tell the founder the standup failed");
  }
}

/**
 * Run the standup, retrying while retrying can help: a live lease is waited out, a failed send is retried
 * after the lease expires, an unexpected error after a short pause. Bounded, and it never throws.
 */
export async function runStandupWithRetry(deps: StandupDeps, retry: RetryDeps = REAL_RETRY): Promise<RunResult> {
  let last: RunResult = { kind: "failed", error: "the standup did not run" };
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      last = await runStandup(deps);
    } catch (err) {
      last = { kind: "failed", error: describeSendError(err) };
      deps.log.error({ component: "goals-standup", attempt, error: last.error }, "Goal standup attempt failed with an unexpected error");
    }
    const wait = retryDelayMs(last);
    if (wait === null) return last;
    if (attempt === RETRY_MAX_ATTEMPTS) break;
    await retry.sleep(wait);
  }
  if (last.kind === "sent") return last; // delivered; some goals were held by another run and are its to send
  deps.log.error({ component: "goals-standup", attempts: RETRY_MAX_ATTEMPTS, outcome: last.kind }, "Goal standup gave up after retries");
  await alertFailure(deps, last);
  return last;
}

export type CatchUpResult =
  | { readonly kind: "not-due"; readonly reason: "outside-window" | "already-sent" }
  | { readonly kind: "ran"; readonly result: RunResult };

/** The boot-time question: is today's standup due and not yet sent? If so, run the same function once. */
export async function runStandupCatchUp(deps: StandupDeps, retry: RetryDeps = REAL_RETRY): Promise<CatchUpResult> {
  const now = deps.now();
  if (!isWithinStandupWindow(now, deps.timeZone)) return { kind: "not-due", reason: "outside-window" };
  if (await deps.repo.hasSentReview(deps.tenant, localDateKey(now, deps.timeZone))) return { kind: "not-due", reason: "already-sent" };
  return { kind: "ran", result: await runStandupWithRetry(deps, retry) };
}

export interface ScheduleOptions {
  readonly makeDeps?: () => Promise<StandupDeps>;
  readonly retry?: RetryDeps;
  readonly log?: StandupLog;
}

/** Register the 09:00 cron. Returns `tick`, the function it runs, so a test can drive it directly. */
export function scheduleGoalStandup(opts: ScheduleOptions = {}): { tick: () => Promise<RunResult> } {
  const makeDeps = opts.makeDeps ?? defaultMakeDeps;
  const retry = opts.retry ?? REAL_RETRY;
  const log = opts.log ?? defaultLog;
  const tick = async (): Promise<RunResult> => runStandupWithRetry(await makeDeps(), retry);
  const timezone = appTimeZone();
  cron.schedule(
    STANDUP_CRON,
    () => {
      tick().catch((err) => log.error({ component: "goals-standup", error: describeSendError(err) }, "Goal standup cron error"));
    },
    { timezone },
  );
  log.info({ cron: STANDUP_CRON, timezone }, "Goal standup scheduled");
  return { tick };
}

/**
 * Called once from src/index.ts after the scheduler starts. Never rejects: an unhandled rejection at boot
 * would take the whole process down (src/index.ts exits on one), and a standup that could not be caught up
 * is a log line, not a reason to stop the bot.
 */
export async function runGoalStandupCatchUp(opts: ScheduleOptions = {}): Promise<void> {
  const log = opts.log ?? defaultLog;
  try {
    const deps = await (opts.makeDeps ?? defaultMakeDeps)();
    const result = await runStandupCatchUp(deps, opts.retry ?? REAL_RETRY);
    log.info({ component: "goals-standup", result: result.kind === "ran" ? result.result.kind : result.reason }, "Goal standup boot catch-up finished");
  } catch (err) {
    log.error({ component: "goals-standup", error: describeSendError(err) }, "Goal standup boot catch-up failed");
  }
}
