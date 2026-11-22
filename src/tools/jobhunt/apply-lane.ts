/**
 * Shadow apply: which rows to prepare, and which lane each prepared form lands in
 * ===============================================================================
 * PURE, no browser and no database, so every branch is a unit test (tests/unit/jobhunt/apply-lane.test.ts).
 *
 *   auto      no bot check, every required field answered: a later PR may click Submit on its own.
 *   needs_you no bot check, but a question only he can answer, or an emailed confirmation code.
 *   hand_off  a bot check, Workday, an unsupported or expired page, a page with no form: he applies by hand.
 *
 * The cover letter is a paid model call, so shadow runs never write one (SHADOW_LETTER_NOTE says so on every
 * auto row). A cover-letter question therefore does not push a row to needs_you: the letter is the one part
 * auto-send would generate itself.
 */

import type { FormPlanSummary } from "./form-filled.js";
import type { FormPlatform } from "./form-platform.js";
import { classifyFormUrl } from "./form-platform.js";
import { parseGates } from "./gates.js";

export type ApplyLane = "auto" | "needs_you" | "hand_off";

export interface LaneVerdict {
  readonly lane: ApplyLane;
  readonly reason: string;
}

export type LaneInput =
  | { readonly kind: "prepared"; readonly platform: FormPlatform; readonly summary: FormPlanSummary }
  | { readonly kind: "failed"; readonly reason: string; readonly platform: FormPlatform | null };

export const SHADOW_LETTER_NOTE = "letter skipped in shadow";
const MAX_LISTED_QUESTIONS = 5;
const MAX_LABEL_CHARS = 70;
const LETTER_QUESTION = /cover letter|motivation|motivatie|sollicitatiebrief/i;
const BOT_CHECK = /datadome|captcha|bot check|bot-check|turnstile|cloudflare/i;
const EXPIRED = /expired|no longer (?:available|accepting|takes)|position (?:has been )?filled/i;

const clip = (text: string): string => (text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text);

function failedVerdict(reason: string): LaneVerdict {
  if (BOT_CHECK.test(reason)) return { lane: "hand_off", reason: `Bot check blocks automation: ${reason}` };
  if (/workday/i.test(reason)) return { lane: "hand_off", reason: `Workday: ${reason}` };
  if (EXPIRED.test(reason)) return { lane: "hand_off", reason: `Expired: ${reason}` };
  return { lane: "hand_off", reason: `Form not usable: ${reason}` };
}

/** The lane for one prepared (or failed) form. Every reason names the specific cause. */
export function routeLane(input: LaneInput): LaneVerdict {
  if (input.kind === "failed") return failedVerdict(input.reason);
  const { summary, platform } = input;
  if (summary.hasCaptcha) {
    return { lane: "hand_off", reason: "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it" };
  }
  const letterQuestions = summary.requiredUnanswered.filter((q) => LETTER_QUESTION.test(q.label));
  const questions = summary.requiredUnanswered.filter((q) => !LETTER_QUESTION.test(q.label));
  if (questions.length > 0) {
    const listed = questions.slice(0, MAX_LISTED_QUESTIONS).map((q) => clip(q.label)).join("; ");
    const more = questions.length > MAX_LISTED_QUESTIONS ? ` (+${questions.length - MAX_LISTED_QUESTIONS} more)` : "";
    return { lane: "needs_you", reason: `${questions.length} required question(s) unanswered: ${listed}${more}` };
  }
  if (platform === "greenhouse") {
    return { lane: "needs_you", reason: "Greenhouse emails a confirmation code at submit; you type it in" };
  }
  const letter = letterQuestions.length > 0 ? `cover letter field present, ${SHADOW_LETTER_NOTE}` : `no cover letter field, ${SHADOW_LETTER_NOTE}`;
  return { lane: "auto", reason: `${summary.filled} of ${summary.total} fields filled, no required question open, no bot check; ${letter}` };
}

/** The slice of a job_applications row the selection rule reads. */
export interface LaneCandidateRow {
  readonly gate_json: string | null;
  readonly created_at: Date | null;
  readonly applied_at: Date | null;
  readonly skipped_at: Date | null;
  readonly liveness: string;
  readonly apply_lane_at: Date | null;
}

export const LANE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Should this row be opened and routed now? Every gate is a recorded pass (a row with no `gate_json` is
 * legacy: its statuses were never stored, so it is not a yes), caught in the last 24h, not applied or
 * skipped, not known expired, and not routed in the last 24h. Not gated on brief_section.
 */
export function isShadowCandidate(row: LaneCandidateRow, now: Date): boolean {
  const { gates, legacy } = parseGates({ gate_json: row.gate_json });
  if (legacy || gates.length === 0 || gates.some((g) => g.status !== "pass")) return false;
  if (!row.created_at || now.getTime() - row.created_at.getTime() > LANE_WINDOW_MS) return false;
  if (row.applied_at || row.skipped_at || row.liveness === "expired") return false;
  return !row.apply_lane_at || now.getTime() - row.apply_lane_at.getTime() >= LANE_WINDOW_MS;
}

/**
 * The rows one pass handles, oldest first (the oldest is closest to leaving the 24h window). Rows that need no
 * browser (Workday, aggregators, any unsupported host) are all taken: they are routed from the URL alone and
 * never use a slot. Rows that open a browser fill at most `browserSlots`.
 */
export function selectShadowBatch<R extends LaneCandidateRow & { readonly url: string | null }>(
  rows: readonly R[],
  now: Date,
  browserSlots: number,
): R[] {
  const oldestFirst = rows
    .filter((r) => isShadowCandidate(r, now))
    .sort((a, b) => (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0));
  let slots = Math.max(0, browserSlots);
  return oldestFirst.filter((r) => {
    if (!classifyFormUrl(r.url ?? "").supported) return true;
    if (slots <= 0) return false;
    slots -= 1;
    return true;
  });
}
