/**
 * Apply material: the files and facts one application needs
 * ==========================================================
 * Shared by the Telegram `/apply` path and the Mini App Submit (apply-submit.ts): where a chat's
 * artifacts live, which resume PDF to attach, the cover letter, and whether a row is already applied.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ARTIFACT_ROOT, TENANT } from "../core/config.js";
import type { JobApplication } from "../db/schema.js";
import { readFullCvText } from "../tools/career.js";
import { tailoredCvPath } from "../tools/jobhunt/apply-packet.js";
import type { ApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { renderCvToPdf } from "../tools/jobhunt/cv-renderer.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import type { CoverLetterOutcome } from "./apply-cover-letter.js";
import { getRunnerDeps } from "./apply-session.js";

export function artifactDirForChat(chatId: string): string {
  return path.join(ARTIFACT_ROOT, `${TENANT}:${chatId}`.replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function resolveResumePdf(
  row: JobApplication,
  profile: JobSearchProfile,
  applyProfile: ApplyProfile,
  artifactDir: string,
): Promise<{ readonly ok: true; readonly pdfPath: string } | { readonly ok: false; readonly reason: string }> {
  const tailored = tailoredCvPath(artifactDir, row);
  if (await fileExists(tailored)) return { ok: true, pdfPath: tailored };

  const configured = (row.track ? applyProfile.resumes?.[row.track] : undefined) ?? applyProfile.default_resume ?? "";
  if (configured && (await fileExists(configured))) return { ok: true, pdfPath: configured };

  const cv = readBaseCv(row, profile);
  if (!cv.ok) return { ok: false, reason: `Configured resume (${configured || "unset"}) is missing and base CV read failed: ${cv.error}` };

  try {
    await fs.mkdir(artifactDir, { recursive: true });
    const rendered = await renderCvToPdf(cv.text);
    const fallbackPath = path.join(artifactDir, `cv-base-${profile.id}.pdf`);
    await fs.writeFile(fallbackPath, rendered.pdfBuffer);
    return { ok: true, pdfPath: fallbackPath };
  } catch (err) {
    return { ok: false, reason: `Could not render fallback CV PDF: ${(err as Error).message}` };
  }
}

function readBaseCv(row: JobApplication, profile: JobSearchProfile): ReturnType<typeof readFullCvText> {
  const trackConfig = row.track ? profile.tracks[row.track] : undefined;
  const explicitPaths = [...(trackConfig?.cvPath ? [trackConfig.cvPath] : []), ...(profile.baseCvPath ? [profile.baseCvPath] : [])];
  return readFullCvText(row.track, explicitPaths.length > 0 ? explicitPaths : undefined);
}

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
