/**
 * FounderOS — the funnel's back half
 * ===================================
 * `/applied N` records that a form went out. Nothing before T3 (2026-08-25)
 * ever asked what happened next: `followups_sent`, the `replied`/`rejected`
 * stages, and `listLiveApplications()` all existed with zero writers or
 * callers — the pipeline could say how many applications went out, and
 * nothing else.
 *
 * Two deterministic, zero-LLM sweeps live here:
 *   - the weekly digest: a numbered list of everything still live, so
 *     `/replied N` and `/rejected N` (jobhunt-commands.ts) have numbers to
 *     resolve against.
 *   - the day-7/day-14 follow-up nudge: a plain templated reminder, not an
 *     LLM draft — this is a cron sweep in the same zero-cost lane as the free
 *     board sweep, not a place to add a new paid-model call path.
 */

import type { JobApplication } from "../../db/schema.js";
import {
  listLiveApplications,
  listFollowupCandidates,
  incrementFollowupsSent,
} from "../../db/job-queries.js";
import { sendToChat } from "../../infra/telegram-send.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "tool:pipeline-followup" });

/** Minimal HTML escape — not importing gateway/approval-card's safeHtml: R1
 * (verify-architecture.ts) forbids anything outside src/gateway from
 * importing gateway modules, and company/title strings need no more than this. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function daysSince(date: Date | null, now: Date): number {
  if (!date) return 0;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * The Monday pipeline review, rendered. Pure — testable without a database.
 *
 * Numbers are NOT pinned anywhere; `/replied N`/`/rejected N` re-run
 * `listLiveApplications()` fresh and take the Nth row by the same default
 * ordering (stalest contact first) — see jobhunt-commands.ts for why brief_rank
 * cannot be reused here (it is cleared the moment a row is marked applied).
 */
export function formatPipelineDigest(rows: readonly JobApplication[], now: Date = new Date()): string {
  if (rows.length === 0) {
    return "📭 <b>Pipeline review</b>\n\nNothing live right now — every application has been marked replied, rejected, or is still in today's queue.";
  }

  const lines = rows.map((row, i) => {
    const n = i + 1;
    const days = daysSince(row.last_contact_at ?? row.applied_at, now);
    const age = row.stage === "applied" ? ` — applied ${days}d ago` : ` — ${row.stage}`;
    return `${n}. ${esc(row.company)} — ${esc(row.title)}${age}\n    <code>/replied ${n}</code> · <code>/rejected ${n}</code>`;
  });

  return (
    `📋 <b>Pipeline review — ${rows.length} live</b>\n\n` +
    lines.join("\n\n") +
    `\n\n<i>Numbers are only valid against this list — if it's changed, ask for a fresh review.</i>`
  );
}

/** Runs the digest sweep and sends it. Fire-and-forget from the cron's perspective. */
export async function runPipelineDigest(): Promise<void> {
  const rows = await listLiveApplications({ limit: 50 });
  await sendToChat(formatPipelineDigest(rows), "HTML");
}

/** Plain templated nudge — no LLM call. `nudgeNumber` only changes the tone, not the facts. */
export function formatFollowupNudge(row: JobApplication, nudgeNumber: 1 | 2, now: Date = new Date()): string {
  const days = daysSince(row.last_contact_at ?? row.applied_at, now);
  const heading = nudgeNumber === 1 ? "🔔 Follow-up due (day 7)" : "🔔 Second follow-up due (day 14)";
  const draft =
    `Hi — following up on my application for the ${row.title} role, submitted ${days} days ago. ` +
    `Happy to answer any questions in the meantime — is there an update on next steps?`;
  return (
    `${heading} — <b>${esc(row.company)}</b> (${esc(row.title)})\n\n` +
    `Draft to send:\n<i>${esc(draft)}</i>\n\n` +
    `Then <code>/replied</code> if they answer, or leave it — day 14 gets one more nudge, then it goes quiet.`
  );
}

export interface FollowupSweepOutcome {
  readonly sent: number;
  readonly failed: number;
}

/**
 * One pass: find every row due a day-7 or day-14 nudge, send it, increment
 * followups_sent. A send failure for one row must not stop the rest — same
 * reasoning every other sweep in this codebase already applies.
 */
export async function runFollowupSweep(now: Date = new Date()): Promise<FollowupSweepOutcome> {
  const candidates = await listFollowupCandidates({ now });
  let sent = 0;
  let failed = 0;

  for (const row of candidates) {
    const nudgeNumber: 1 | 2 = row.followups_sent === 0 ? 1 : 2;
    try {
      await sendToChat(formatFollowupNudge(row, nudgeNumber, now), "HTML");
      await incrementFollowupsSent(row.id, row.tenant_id);
      sent += 1;
    } catch (err) {
      failed += 1;
      log.error(
        { err: (err as Error).message, company: row.company, id: row.id },
        "Follow-up nudge failed to send — not marking it sent, will retry next sweep",
      );
    }
  }

  return { sent, failed };
}
