/**
 * FounderOS: pre-tailoring the apply-today roles
 * ==============================================
 * Prod 2026-10-05: 2 applications ever, 5 of 4,456 rows with a tailored CV. Tailoring ran only when the founder
 * tapped Draft and took 20-40 s, so on a phone the tap felt broken. This runs the SAME tailoring the Draft button
 * runs, early in the morning, for the three roles the brief card will show, so the tap returns a stored file.
 *
 * What it does not do: send, submit or message anyone. It tailors and stores. The founder still taps Draft, opens
 * the form and taps "I applied" himself (ADR-018). `tests/unit/jobhunt/pretailor.test.ts` fails if this file or
 * its wiring imports anything that sends.
 *
 * All I/O is injected (`PretailorDeps`, `PretailorRowDeps`), so the rules below are unit-tested with fakes at $0.
 * The real wiring is in pretailor-cron.ts.
 *
 * Cost, stated plainly: per role one CV tailoring (up to 2 model calls with a revision) and one cover letter
 * (up to 2). Typical 4 calls a role, worst case 10. Three roles x two profiles: about 12 calls on a normal day
 * (most roles are already stored after the first week), 30 at the very worst. Stops at the daily budget.
 */

import { childLogger } from "../../infra/logger.js";
import { appTimeZone, wallDate } from "../../core/time.js";
import type { JobApplication } from "../../db/schema.js";
import type { JobSearchProfile } from "./profile-config.js";

const log = childLogger({ module: "jobhunt:pretailor" });

/** Roles pre-tailored per profile per day. Equals the roles the brief card shows (a test pins that). */
export const PRETAILOR_PER_PROFILE_CAP = 3;
/** `action_log.action` for one profile's run on one day. */
export const PRETAILOR_ACTION = "jobhunt_pretailor";

export type PretailorRowInput = Pick<
  JobApplication,
  "id" | "company" | "title" | "brief_section" | "tailor_status" | "tailored_cv_s3_key" | "cover_letter_s3_key"
>;

export interface PretailorSummary {
  readonly attempted: number;
  readonly stored: number;
  readonly failed: number;
}

export type PretailorStatus = "ran" | "already-ran" | "budget-exhausted" | "nothing-to-do" | "rank-failed";

export interface PretailorOutcome extends PretailorSummary {
  readonly profileId: string;
  readonly status: PretailorStatus;
}

export type RowResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface PretailorDeps<R extends PretailorRowInput = PretailorRowInput> {
  readonly profiles: () => readonly JobSearchProfile[];
  /** Pins brief_section and brief_rank on the profile's rows. Zero model calls. */
  readonly refreshRanks: (profile: JobSearchProfile) => Promise<void>;
  readonly listQueue: (profile: JobSearchProfile) => Promise<readonly R[]>;
  readonly budgetAllows: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly alreadyRan: (key: string) => Promise<boolean>;
  readonly recordRun: (key: string, profile: JobSearchProfile, summary: PretailorSummary) => Promise<void>;
  readonly tailorRow: (row: R, profile: JobSearchProfile) => Promise<RowResult>;
  readonly now: () => Date;
}

/** One key per profile per local day: the idempotency key of the run's action_log row. */
export function pretailorAuditKey(profileId: string, when: Date, timeZone: string): string {
  const { y, mo, d } = wallDate(when, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${PRETAILOR_ACTION}:${profileId}:${y}-${pad(mo)}-${pad(d)}`;
}

/**
 * The roles to tailor: the ones the brief card shows (DO TODAY, best rank first, at most the cap) that have no
 * stored CV yet. A role that failed is not retried each morning, and one being tailored right now is left alone.
 * Looking only at the card window is deliberate: a fourth role is a role the founder was not shown.
 */
export function selectPretailorRows<R extends PretailorRowInput>(queue: readonly R[]): R[] {
  const shown = queue.filter((r) => r.brief_section === "do_today").slice(0, PRETAILOR_PER_PROFILE_CAP);
  return shown.filter((r) => r.tailored_cv_s3_key === null && r.tailor_status !== "failed" && r.tailor_status !== "tailoring");
}

const idle = (profileId: string, status: PretailorStatus): PretailorOutcome => ({ profileId, status, attempted: 0, stored: 0, failed: 0 });

/**
 * The daily run. Profiles go one after another, roles one after another (each is a model call plus a Chromium
 * launch, and the box has 4 GB). The budget is checked before every role; when it is spent the whole run stops with
 * one log line and the day stays open, so a restart continues where it stopped (stored roles are skipped).
 * A profile that finished is recorded once per local day, so a second run the same day does nothing.
 */
export async function runPretailor<R extends PretailorRowInput>(deps: PretailorDeps<R>, timeZone: string = appTimeZone()): Promise<PretailorOutcome[]> {
  const outcomes: PretailorOutcome[] = [];
  let budgetSpent = false;
  for (const profile of deps.profiles()) {
    if (budgetSpent) {
      outcomes.push(idle(profile.id, "budget-exhausted"));
      continue;
    }
    const key = pretailorAuditKey(profile.id, deps.now(), timeZone);
    if (await deps.alreadyRan(key)) {
      outcomes.push(idle(profile.id, "already-ran"));
      continue;
    }
    let queue: readonly R[];
    try {
      await deps.refreshRanks(profile);
      queue = await deps.listQueue(profile);
    } catch (err) {
      // allow-failopen: one profile that cannot be ranked must not stop the other; tomorrow tries again.
      log.error({ profile: profile.id, err: (err as Error).message }, "Pre-tailor skipped: could not rank the queue");
      outcomes.push(idle(profile.id, "rank-failed"));
      continue;
    }
    let stored = 0;
    let failed = 0;
    const todo = selectPretailorRows(queue);
    for (const row of todo) {
      const gate = await deps.budgetAllows();
      if (!gate.ok) {
        log.warn({ profile: profile.id, reason: gate.reason }, "Pre-tailor stopped: daily budget spent");
        budgetSpent = true;
        break;
      }
      const res = await deps.tailorRow(row, profile).catch((err: unknown): RowResult => ({ ok: false, reason: (err as Error).message })); // allow-failopen: one bad role is counted, not fatal
      if (res.ok) stored += 1;
      else {
        failed += 1;
        log.warn({ profile: profile.id, id: row.id, company: row.company, reason: res.reason }, "Pre-tailor failed for a role");
      }
    }
    const summary = { attempted: stored + failed, stored, failed };
    if (budgetSpent) {
      outcomes.push({ profileId: profile.id, status: "budget-exhausted", ...summary });
      continue;
    }
    await deps.recordRun(key, profile, summary);
    log.info({ profile: profile.id, ...summary }, "Pre-tailor run done");
    outcomes.push({ profileId: profile.id, status: todo.length === 0 ? "nothing-to-do" : "ran", ...summary });
  }
  return outcomes;
}

export interface PretailorRowDeps<R extends PretailorRowInput = PretailorRowInput> {
  /** The Draft button code path (buildApplicationPacket): tailor, render, store the PDF. */
  readonly buildPacket: (row: R) => Promise<{ readonly ok: true; readonly cvMarkdown: string } | { readonly ok: false; readonly reason: string }>;
  /** True when the role now has a stored CV key. buildApplicationPacket swallows a failed S3 upload, so ask. */
  readonly cvStored: (id: string) => Promise<boolean>;
  /** Writes the cover letter from the tailored CV and stores it. Same function the Draft button uses. */
  readonly writeLetter: (row: R, cvMarkdown: string) => Promise<RowResult>;
  readonly markFailed: (id: string, reason: string) => Promise<void>;
}

/**
 * One role, end to end, through the same functions the Draft button calls. A role that cannot be built is marked
 * failed so tomorrow does not pay for it again. A CV that did not reach storage is not marked: the cause is
 * probably transient, and no letter is paid for. A missing letter costs the letter and not the CV.
 */
export async function pretailorRow<R extends PretailorRowInput>(row: R, deps: PretailorRowDeps<R>): Promise<RowResult> {
  const built = await deps.buildPacket(row);
  if (!built.ok) {
    await deps.markFailed(row.id, built.reason);
    return { ok: false, reason: built.reason };
  }
  if (!(await deps.cvStored(row.id))) return { ok: false, reason: "the CV was built but did not reach storage" };
  const letter = await deps.writeLetter(row, built.cvMarkdown);
  if (!letter.ok) log.warn({ id: row.id, company: row.company, reason: letter.reason }, "Pre-tailor: no cover letter, CV is stored");
  return { ok: true };
}
