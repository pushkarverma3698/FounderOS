/**
 * Apply material: the files and facts one application needs
 * ==========================================================
 * Shared by the Telegram `/apply` path and the Mini App Submit (apply-submit.ts): where a chat's
 * artifacts live, which resume PDF to attach, the cover letter, and whether a row is already applied.
 */

import type { JobApplication } from "../db/schema.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { artifactDirForChat, readBaseCv } from "../tools/jobhunt/resume-pdf.js";
import type { CoverLetterOutcome } from "./apply-cover-letter.js";
import { getRunnerDeps } from "./apply-session.js";

export { artifactDirForChat };

/** The archived letter, else a new one grounded in the base CV. Never throws. */
export function resolveCoverLetter(row: JobApplication, profile: JobSearchProfile, artifactDir: string): Promise<CoverLetterOutcome> {
  const cv = readBaseCv(row, profile);
  return getRunnerDeps().coverLetter(row, cv.ok ? cv.text : null, artifactDir);
}

/** The day a row was applied to, or null. An applied row is never filled or sent again. */
export function appliedOn(row: JobApplication): string | null {
  if (row.applied_at) return new Date(row.applied_at).toISOString().slice(0, 10);
  return row.stage === "applied" ? "an earlier date" : null;
}
