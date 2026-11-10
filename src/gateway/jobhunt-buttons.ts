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
import { markSkipped } from "../db/apply-queries.js";
import { JOB_CALLBACK_PREFIX, jobCallbackData, type JobAction } from "../tools/jobhunt/job-ref.js";

// The payload format is shared with the batched digest (tools), so it is defined there.
export { JOB_CALLBACK_PREFIX, jobCallbackData, type JobAction };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a tapped payload; null for anything that is not ours or has a malformed id. */
export function parseJobCallback(data: string): { action: JobAction; rowId: string } | null {
  if (!data.startsWith(JOB_CALLBACK_PREFIX)) return null;
  const [kind, rowId] = data.slice(JOB_CALLBACK_PREFIX.length).split(":");
  if ((kind !== "d" && kind !== "a" && kind !== "n") || !rowId || !UUID.test(rowId)) return null;
  return { action: kind === "d" ? "draft" : kind === "a" ? "applied" : "skipped", rowId };
}

/** The keyboard under a delivered CV: auto-apply (when enabled), open the form, then close the row out. */
export function packetKeyboard(rowId: string, applyUrl: string, withAutoApply = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (withAutoApply && /^https?:\/\//i.test(applyUrl)) {
    kb.text("🚀 Auto-Apply", `${JOB_CALLBACK_PREFIX}f:${rowId}`).row();
  }
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

/**
 * Write "not for me": `skipped_at`, kept apart from `applied_at` (see the column comment in schema.ts), and drop the
 * brief slot so the role leaves /jobs. Idempotent. A role already applied to is left alone: a skip tap on it
 * must not turn an application into a pass.
 */
export async function markRowSkipped(
  row: JobApplication,
): Promise<{ readonly ok: true; readonly already: "skipped" | "applied" | null } | { readonly ok: false }> {
  if (row.stage === "applied" || row.applied_at) return { ok: true, already: "applied" };
  if (row.skipped_at) return { ok: true, already: "skipped" };
  const changed = await markSkipped([row.id], row.tenant_id, { clearBrief: true });
  return changed > 0 ? { ok: true, already: null } : { ok: false };
}

type Markup = readonly (readonly { readonly text: string; readonly callback_data?: string; readonly url?: string }[])[];

/** True when a keyboard holds buttons for more than one role (a digest), not just one role's packet. */
export function isMultiRoleKeyboard(markup: Markup): boolean {
  const ids = new Set<string>();
  for (const row of markup) for (const b of row) {
    const parsed = b.callback_data ? parseJobCallback(b.callback_data) : null;
    if (parsed) ids.add(parsed.rowId);
  }
  return ids.size > 1;
}

/**
 * The keyboard after a tap in a digest: that role's row becomes one button that says what was recorded, and every
 * other role keeps its buttons. The kept button re-sends the same tap, which is idempotent.
 */
export function keyboardAfterTap(markup: Markup, rowId: string, action: "applied" | "skipped", company: string): { text: string; callback_data: string }[][] {
  const label = action === "applied" ? `✅ Applied — ${company.slice(0, 30)}` : `⏭ Skipped — ${company.slice(0, 30)}`;
  return markup.map((row) => {
    const ours = row.some((b) => b.callback_data && parseJobCallback(b.callback_data)?.rowId === rowId);
    return ours
      ? [{ text: label, callback_data: jobCallbackData(action, rowId) }]
      : row.flatMap((b) => (b.callback_data ? [{ text: b.text, callback_data: b.callback_data }] : []));
  });
}
