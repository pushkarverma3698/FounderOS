/**
 * Open questions for one profile: gathers the two shadow-apply sources over the last 14 days (the lane reason
 * on each needs_you row, and the prepared-form snapshot when there is one), then lets open-questions.ts cluster
 * and rank them against what the profile and dossier already answer.
 */

import { listNeedsYouReasons, type LaneReasonRow } from "../db/job-apply-lane-queries.js";
import { applyProfilePathFor, readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { loadApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { lookupLearnedAnswer, readCandidateDossier } from "../tools/jobhunt/candidate-dossier.js";
import { collectOpenQuestions, type OpenQuestions, type QuestionSource } from "../tools/jobhunt/open-questions.js";

export const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = /^\d+ required question\(s\) unanswered: (.*?)(?: \(\+\d+ more\))?$/;

export interface QuestionsDeps {
  readonly rows: (profileId: string, since: Date) => Promise<LaneReasonRow[]>;
  readonly snapshot: typeof loadApplySnapshot;
}
const defaults: QuestionsDeps = { rows: listNeedsYouReasons, snapshot: loadApplySnapshot };

/** The labels a lane reason lists (clipped to 70 characters by the lane, so only a fallback). */
export function labelsFromReason(reason: string): string[] {
  const m = REASON.exec(reason);
  return m?.[1] ? m[1].split("; ").map((l) => l.trim()).filter(Boolean) : [];
}

export async function loadQuestionSources(profileId: string, now: Date, deps: QuestionsDeps = defaults): Promise<QuestionSource[]> {
  const rows = await deps.rows(profileId, new Date(now.getTime() - WINDOW_DAYS * DAY_MS));
  return rows.flatMap((row) => {
    const snap = deps.snapshot(row.id);
    const open = snap?.summary.unanswered.filter((q) => q.required);
    if (open && open.length > 0) {
      return open.map((q) => ({ rowId: row.id, company: row.company, label: q.label, fieldType: q.fieldType, ...(q.options ? { options: q.options } : {}) }));
    }
    return labelsFromReason(row.reason).map((label) => ({ rowId: row.id, company: row.company, label }));
  });
}

export async function openQuestionsFor(profileId: string, now: Date, deps: QuestionsDeps = defaults): Promise<OpenQuestions> {
  const [sources, read, dossier] = await Promise.all([
    loadQuestionSources(profileId, now, deps),
    readApplyProfile(applyProfilePathFor(profileId)),
    readCandidateDossier(profileId),
  ]);
  const profile = read.ok ? read.profile : null;
  return collectOpenQuestions(sources, (label, options) => profile !== null && lookupLearnedAnswer(label, options, profile, dossier ?? undefined) !== null);
}
