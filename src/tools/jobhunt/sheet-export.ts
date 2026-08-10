/**
 * FounderOS — publish the job queue to the Sheet
 * ==============================================
 * Database → rows → two tabs. The Sheet is a VIEW: it is rebuilt from Postgres
 * on every sweep and never read back as truth. Nothing the founder types into
 * a cell survives the next write, and that is deliberate — two writable copies
 * of the queue would fork the moment one of them failed to sync, and he would
 * apply twice to a role that one copy said was still open.
 *
 * The Sheet replaced the Telegram brief on 2026-08-06 (founder decision): the
 * brief's job was to end in an action, and forty ranked rows of prose in a chat
 * window is not where a person picks the next thing to do.
 *
 * WHAT THIS DOES NOT DO: it never fails the sweep. The postings are screened
 * and recorded before it runs, so an export failure costs a view of the data
 * and not the data. It reports the failure loudly and returns.
 */

import { childLogger } from "../../infra/logger.js";
import { env } from "../../core/config.js";
import { listApplyQueue, listRecentlyScreened } from "../../db/apply-queries.js";
import { writeTab, type SheetTarget } from "./sheet-client.js";
import { buildQueueTab, buildLogTab } from "./sheet-rows.js";

const log = childLogger({ module: "jobhunt:sheet-export" });

export const QUEUE_TAB = "Queue";
export const LOG_TAB = "Log";

export type ExportResult =
  | { readonly ok: true; readonly queued: number; readonly logged: number; readonly url: string }
  | { readonly ok: false; readonly skipped: true; readonly reason: string }
  | { readonly ok: false; readonly skipped: false; readonly reason: string };

/** The link the founder taps. Stable for the life of the spreadsheet. */
export function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

/**
 * Where the Sheet lives, or why we cannot write to it.
 *
 * Returns a reason rather than throwing, because "not configured yet" and
 * "configured and broken" need different handling: the first is the expected
 * state before the founder has created the spreadsheet, the second is an
 * outage. Only the second is worth interrupting him for.
 */
export function sheetTargetFrom(
  source: { JOBHUNT_SHEET_ID?: string; GOOGLE_SHEETS_CREDENTIALS_PATH?: string } = env,
): SheetTarget | { readonly missing: string } {
  const spreadsheetId = source.JOBHUNT_SHEET_ID;
  const credentialsPath = source.GOOGLE_SHEETS_CREDENTIALS_PATH;
  if (!spreadsheetId && !credentialsPath) {
    return { missing: "JOBHUNT_SHEET_ID and GOOGLE_SHEETS_CREDENTIALS_PATH are not set" };
  }
  if (!spreadsheetId) return { missing: "JOBHUNT_SHEET_ID is not set" };
  if (!credentialsPath) return { missing: "GOOGLE_SHEETS_CREDENTIALS_PATH is not set" };
  return { spreadsheetId, credentialsPath };
}

/**
 * Rebuild both tabs from the database.
 *
 * Queue first, Log second, on purpose. If the second write fails the founder is
 * left with a current queue and a stale audit trail, which is the harmless
 * direction — the reverse would leave him working from yesterday's shortlist.
 */
export async function exportJobSheet(now: Date = new Date()): Promise<ExportResult> {
  const target = sheetTargetFrom();
  if ("missing" in target) {
    log.info({ reason: target.missing }, "Sheet export skipped — not configured");
    return { ok: false, skipped: true, reason: target.missing };
  }

  try {
    const [queue, screened] = await Promise.all([listApplyQueue(), listRecentlyScreened()]);
    await writeTab(target, QUEUE_TAB, buildQueueTab(queue, now));
    await writeTab(target, LOG_TAB, buildLogTab(screened, now));

    log.info({ queued: queue.length, logged: screened.length }, "Job sheet exported");
    return {
      ok: true,
      queued: queue.length,
      logged: screened.length,
      url: sheetUrl(target.spreadsheetId),
    };
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ err: reason }, "Sheet export failed");
    return { ok: false, skipped: false, reason };
  }
}
