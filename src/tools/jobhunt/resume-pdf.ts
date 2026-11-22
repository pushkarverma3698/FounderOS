/**
 * Resume PDF resolution: which CV file one application attaches
 * ==============================================================
 * Shared by the manual apply path (src/gateway/apply-material.ts) and the shadow pass (shadow-apply.ts).
 * Order: the tailored CV from /draft-tailored, else the apply profile's configured path, else a PDF
 * rendered locally from the base cv.md (no model call, $0). Lives in src/tools so both layers can import it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ARTIFACT_ROOT, TENANT } from "../../core/config.js";
import type { JobApplication } from "../../db/schema.js";
import { readFullCvText } from "../career.js";
import { tailoredCvPath } from "./apply-packet.js";
import type { ApplyProfile } from "./apply-profile.js";
import { renderCvToPdf } from "./cv-renderer.js";
import type { JobSearchProfile } from "./profile-config.js";

/** What resolution reads off a row (a full JobApplication satisfies it). */
export type ResumeRow = Pick<JobApplication, "id" | "company" | "track">;

export type ResumeResolution = { readonly ok: true; readonly pdfPath: string } | { readonly ok: false; readonly reason: string };

/** Where one chat's artifacts (tailored CVs, letters, rendered fallbacks) live. */
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

export function readBaseCv(row: Pick<JobApplication, "track">, profile: JobSearchProfile): ReturnType<typeof readFullCvText> {
  const trackConfig = row.track ? profile.tracks[row.track] : undefined;
  const explicitPaths = [...(trackConfig?.cvPath ? [trackConfig.cvPath] : []), ...(profile.baseCvPath ? [profile.baseCvPath] : [])];
  return readFullCvText(row.track, explicitPaths.length > 0 ? explicitPaths : undefined);
}

export async function resolveResumePdf(
  row: ResumeRow,
  profile: JobSearchProfile,
  applyProfile: ApplyProfile,
  artifactDir: string,
): Promise<ResumeResolution> {
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
