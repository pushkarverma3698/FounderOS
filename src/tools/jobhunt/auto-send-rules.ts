/**
 * Auto-send: may this prepared row go out without a tap? (ADR-018 amendment 2026-11-15)
 * ===================================================================================
 * PURE, no browser, no database, no clock of its own: every branch is a unit test
 * (tests/unit/jobhunt/auto-send-rules.test.ts). Founder rule: "send without a tap when the form has no bot
 * check, every answer is one I approved, and the limits allow it."
 *
 * The first refusal wins and says why. Order: switches, lane, bot check, unanswered questions, answer sources,
 * the daily cap, the per-company cooldown. A refusal never sends anything.
 */

import type { FormPlanSummary } from "./form-filled.js";
import { isTrustedAnswer } from "./answer-source.js";
import type { LaneVerdict } from "./apply-lane.js";
import { normaliseCompanyName } from "./sponsor-match.js";

export const DEFAULT_DAILY_CAP = 10;
export const COMPANY_COOLDOWN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches apply-lane.ts: a cover-letter question is the one required field auto-send fills itself. */
const LETTER_QUESTION = /cover letter|motivation|motivatie|sollicitatiebrief/i;

export interface AutoSendVerdict extends LaneVerdict {
  /** The plan summary of the prepared form; absent when the form could not be prepared. */
  readonly summary?: FormPlanSummary;
}

export interface AutoSendLimits {
  /** `AUTO_APPLY_SEND=on`. */
  readonly envOn: boolean;
  /** This profile's runtime switch (`/autoapply on`). Both must be on. */
  readonly runtimeOn: boolean;
  readonly dailyCap: number;
  readonly now: Date;
}

export interface AutoSendHistory {
  /** Auto-send attempts for this profile since the start of today (UTC), confirmed or not. */
  readonly sentToday: number;
  /** Every application this profile applied to or auto-sent in the cooldown window. */
  readonly recent: readonly { readonly company: string; readonly at: Date }[];
}

/** What the send path reports back to the shadow pass (the gateway's richer outcome satisfies it). */
export interface AutoSendOutcomeLite {
  readonly kind: "sent" | "no-letter" | "skipped";
  readonly detail: string;
}

export type AutoSendDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function dailyCapFrom(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env["AUTO_APPLY_DAILY_CAP"] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

export function autoSendEnvOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["AUTO_APPLY_SEND"] ?? "").trim().toLowerCase() === "on";
}

/** A required cover-letter question the form shows: the send path must produce a clean letter or not send. */
export function letterIsRequired(summary: FormPlanSummary): boolean {
  return summary.requiredUnanswered.some((q) => LETTER_QUESTION.test(q.label));
}

const no = (reason: string): AutoSendDecision => ({ ok: false, reason });

export function canAutoSend(
  row: { readonly company: string },
  verdict: AutoSendVerdict,
  limits: AutoSendLimits,
  history: AutoSendHistory,
): AutoSendDecision {
  if (!limits.envOn) return no("AUTO_APPLY_SEND is off");
  if (!limits.runtimeOn) return no("/autoapply is off for this profile");
  if (verdict.lane !== "auto") return no(`lane is ${verdict.lane}, not auto`);
  const summary = verdict.summary;
  if (!summary) return no("no prepared form to send");
  if (summary.hasCaptcha) return no("the form has a bot check");
  const open = summary.requiredUnanswered.filter((q) => !LETTER_QUESTION.test(q.label));
  if (open.length > 0) return no(`${open.length} required question(s) unanswered`);
  const untrusted = summary.filledAnswers.filter((a) => !isTrustedAnswer(a));
  if (untrusted.length > 0) return no(`${untrusted.length} filled answer(s) not from the profile, dossier or approved answers: ${untrusted.map((a) => a.label).join("; ")}`);
  if (history.sentToday >= limits.dailyCap) return no(`daily cap reached (${history.sentToday} of ${limits.dailyCap})`);
  const company = normaliseCompanyName(row.company);
  if (company === "") return no("company name is empty, so the 30-day check cannot run");
  const since = limits.now.getTime() - COMPANY_COOLDOWN_DAYS * DAY_MS;
  const hit = history.recent.find((r) => r.at.getTime() >= since && normaliseCompanyName(r.company) === company);
  if (hit) return no(`already applied to this company within ${COMPANY_COOLDOWN_DAYS} days`);
  return { ok: true };
}
