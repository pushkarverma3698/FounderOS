/**
 * FounderOS — job buttons (apply from a phone)
 * ============================================
 * The apply loop used to end in a shell command: "run `cd ~/Projects/founderos/
 * mac-client && …` on your Mac" and "type /applied 3". On a phone that is
 * unusable, and prod showed it: 4,307 screened rows, 2 applications.
 *
 * The loop is now two taps: 📝 Draft (tailor the CV for this role) and, once the
 * founder has applied in the browser, ✅ I applied.
 *
 * BUTTONS CARRY THE ROW ID, NOT THE BRIEF NUMBER. Brief numbers are re-pinned on
 * every rebuild, so "/draft 3" on a three-day-old alert can mean a different
 * company today. A row id never changes; the button on the old message still
 * names the company it was printed for (audit task P0-2).
 *
 * Pure builders plus `markRowApplied`, the one place "applied" is written, shared
 * by `/applied N` and the ✅ button so both do exactly the same thing.
 */

import { InlineKeyboard } from "grammy";
import type { JobApplication } from "../db/schema.js";
import { updateApplicationStage } from "../db/job-queries.js";

/** Callback prefix. Short: Telegram caps callback_data at 64 bytes and a UUID is 36. */
export const JOB_CALLBACK_PREFIX = "jh:";

export type JobAction = "draft" | "applied";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function jobCallbackData(action: JobAction, rowId: string): string {
  return `${JOB_CALLBACK_PREFIX}${action === "draft" ? "d" : "a"}:${rowId}`;
}

/** Parse a tapped payload; null for anything that is not ours or has a malformed id. */
export function parseJobCallback(data: string): { action: JobAction; rowId: string } | null {
  if (!data.startsWith(JOB_CALLBACK_PREFIX)) return null;
  const [kind, rowId] = data.slice(JOB_CALLBACK_PREFIX.length).split(":");
  if ((kind !== "d" && kind !== "a") || !rowId || !UUID.test(rowId)) return null;
  return { action: kind === "d" ? "draft" : "applied", rowId };
}

/** The keyboard under a delivered CV: open the form, then close the row out. */
export function packetKeyboard(rowId: string, applyUrl: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Telegram refuses a url button whose URL is not http(s); an empty one is
  // already reported in the message text, so the button is simply left out.
  if (/^https?:\/\//i.test(applyUrl)) kb.url("🔗 Open the form", applyUrl).row();
  return kb.text("✅ I applied", jobCallbackData("applied", rowId));
}

/** A "📝 Draft" button per role, one row each, labelled with the company. */
export function draftKeyboard(rows: readonly Pick<JobApplication, "id" | "company">[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of rows) kb.text(`📝 Draft — ${r.company.slice(0, 40)}`, jobCallbackData("draft", r.id)).row();
  return kb;
}

/**
 * Write "applied": stage, the day-zero timestamps for the follow-up clock, and
 * drop the pinned brief number so the row leaves the queue. Idempotent: a second
 * tap on a row already applied changes nothing and says so.
 */
export async function markRowApplied(
  row: JobApplication,
): Promise<{ readonly ok: true; readonly already: boolean } | { readonly ok: false }> {
  if (row.stage === "applied" || row.applied_at) return { ok: true, already: true };
  const now = new Date();
  const updated = await updateApplicationStage(row.id, "applied", {
    appliedAt: now,
    // The day WE applied is day zero for the day-7/day-14 follow-up nudge.
    lastContactAt: now,
    clearBriefRank: true,
  });
  return updated ? { ok: true, already: false } : { ok: false };
}
