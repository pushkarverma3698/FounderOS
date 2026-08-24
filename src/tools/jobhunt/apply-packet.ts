/**
 * FounderOS — the application packet
 * ===================================
 * One row of the brief turned into the three things an application actually
 * needs: a tailored CV as an ATS-safe PDF, the skills that matched (so the
 * founder knows what he is leading with), and the URL that opens the form.
 *
 * WHY THIS IS ITS OWN MODULE. Until 2026-08-21 this logic lived inside
 * `handleDraft`, reachable only by typing `/draft 3`. The kernel — the thing
 * that answers plain English — had no tool that could tailor a CV at all
 * (`capabilities.ts` gave the jobhunt worker `write_artifact` and nothing else
 * that could produce a document). So when the founder typed "apply all of them
 * by drafting proper resumes for each job" on 2026-08-21, the model did the only
 * thing its toolset allowed: it wrote a markdown blob out of its own context and
 * reported it as tailored resumes. Prod logs show `read_cv` had failed 90
 * seconds earlier, so those "resumes" were composed with ZERO CV input.
 *
 * Extracting the packet here is what closes that hole. Both entry points —
 * `/draft N` and the `tailor_cv` kernel tool — call this one function, and this
 * function cannot produce a CV without `readFullCvText` succeeding. A fabricated
 * resume stops being a thing the model is able to do, rather than a thing it is
 * asked not to do (rule #27: a rule with no mechanism decays).
 *
 * Failure is a RESULT, not a throw. A thin JD, model slop that survives one
 * revision, a Chromium crash — all expected, all recoverable by falling back to
 * a text draft, and that fallback should be one `if` at the call site rather
 * than a try/catch pyramid.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { childLogger } from "../../infra/logger.js";
import { uploadFile } from "../../infra/storage/s3-client.js";
import {
  getApplicationByBriefRank,
  recordTailoringResult,
  type BriefSection,
} from "../../db/job-queries.js";
import type { JobApplication } from "../../db/schema.js";
import { tailorCv } from "./tailor-cv.js";
import { renderCvToPdf } from "./cv-renderer.js";
import { extractBoardToken } from "./board-token.js";
import { getAdapter } from "./adapters/index.js";

export function getApplyUrl(url: string, company: string): string | null {
  if (!url) return null;
  const token = extractBoardToken(url);
  if (!token) return null;
  const adapter = getAdapter(token.ats);
  if (!adapter) return null;
  return adapter.applyUrlFor(url, { name: company, ats: token.ats, token: token.token, markets: [] });
}

const log = childLogger({ module: "jobhunt:apply-packet" });

/** Below this, a posting's description is too thin to tailor a CV against. */
export const MIN_DESCRIPTION_CHARS = 50;

/**
 * The sections `/draft` and `tailor_cv` both address, in the words the brief
 * prints them in. They share ONE continuous numbering, pinned by
 * `persistBriefRanks` at render time, because a row flagged only on the years
 * bar needs an APPLICATION, not a question.
 */
export const DRAFT_SECTIONS: readonly BriefSection[] = ["do_today", "stretch"];

export interface ApplicationPacket {
  readonly row: JobApplication;
  /** The tailored CV on disk, ready for `deliver_artifact`. */
  readonly pdfPath: string;
  /** The tailored markdown — what the cover letter must be written from. */
  readonly cvMarkdown: string;
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  /** Where to open the application. Never null: falls back to the posting URL. */
  readonly applyUrl: string;
  /** False when `applyUrl` is the posting page because the ATS was unmappable. */
  readonly opensTheForm: boolean;
}

export type PacketResult =
  | { readonly ok: true; readonly packet: ApplicationPacket }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a brief number to a row. PURE LOOKUP — no model, no fuzzy match.
 *
 * At most one section can match, since they share one numbering. A miss is a
 * refusal rather than a near-miss: the cost of picking wrong is a tailored
 * application sent about the wrong company.
 */
export async function resolveBriefRow(
  rank: number,
  sections: readonly BriefSection[] = DRAFT_SECTIONS,
): Promise<JobApplication | null> {
  for (const section of sections) {
    const row = await getApplicationByBriefRank(section, rank);
    if (row) return row;
  }
  return null;
}

/** Where a tailored CV PDF lands — mirrors write-artifact.ts's directory convention. */
export function tailoredCvPath(artifactDir: string, row: JobApplication): string {
  const companySlug = row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "role";
  return path.join(artifactDir, `cv-${companySlug}-${row.id.slice(0, 8)}.pdf`);
}

/**
 * Best-effort durable copy in S3, mirroring `tailor-worker.ts`'s upload shape.
 *
 * Never throws: the PDF is already on disk and about to reach Telegram, and
 * losing the archive copy must not cost the founder the delivery itself.
 */
async function archiveTailoredCv(row: JobApplication, pdfBuffer: Buffer): Promise<void> {
  const slug = row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  try {
    const prefix = `ready-applications/${new Date().toISOString().slice(0, 10)}/${slug}`;
    const s3Key = await uploadFile(pdfBuffer, "tailored_cv.pdf", row.id, prefix);
    await recordTailoringResult(row.id, { tailorStatus: "tailored", tailoredCvS3Key: s3Key });
  } catch (err) {
    log.warn(
      { id: row.id, company: row.company, err: (err as Error).message },
      "S3 archive of tailored CV failed — Telegram delivery still proceeds",
    );
    await recordTailoringResult(row.id, { tailorStatus: "tailored" }).catch(
      // allow-failopen: this is bookkeeping on top of a delivery that already
      // succeeded or is already underway; losing it must not surface as a failure.
      (err2) => log.warn({ id: row.id, err: (err2 as Error).message }, "tailor_status write failed"),
    );
  }
}

/**
 * Tailor + render + locate the form for one row.
 *
 * The tailored markdown is returned alongside the PDF because it — not the base
 * CV — is what the cover letter must be written from: it is already aligned to
 * this posting, so the letter and the CV cannot end up emphasising different
 * things about the same person.
 */
export async function buildApplicationPacket(
  row: JobApplication,
  artifactDir: string,
): Promise<PacketResult> {
  if (!row.description || row.description.trim().length < MIN_DESCRIPTION_CHARS) {
    return { ok: false, reason: "this posting has no usable description on file" };
  }

  const tailored = await tailorCv({
    jobDescription: row.description,
    companyName: row.company,
    jobTitle: row.title,
    track: row.track,
  });
  if (!tailored.success || !tailored.tailoredMarkdown) {
    return { ok: false, reason: tailored.error ?? "CV tailoring failed" };
  }

  try {
    await recordTailoringResult(row.id, { tailorStatus: "tailoring" });
    const rendered = await renderCvToPdf(tailored.tailoredMarkdown);
    const pdfPath = tailoredCvPath(artifactDir, row);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(pdfPath, rendered.pdfBuffer);
    const stats = await fs.stat(pdfPath);
    if (stats.size === 0) throw new Error("PDF render produced 0 bytes");

    await archiveTailoredCv(row, rendered.pdfBuffer);

    const formUrl = getApplyUrl(row.url ?? "", row.company);
    return {
      ok: true,
      packet: {
        row,
        pdfPath,
        cvMarkdown: tailored.tailoredMarkdown,
        matchedSkills: tailored.matchedSkills,
        missingSkills: tailored.missingSkills,
        applyUrl: formUrl ?? row.url ?? "",
        opensTheForm: formUrl !== null,
      },
    };
  } catch (err) {
    const reason = (err as Error).message;
    await recordTailoringResult(row.id, {
      tailorStatus: "failed",
      notes: `PDF render failed: ${reason}`,
    }).catch(
      // allow-failopen: we are already on the failure path and about to fall
      // back to a text draft; losing this status write must not compound it.
      (err2) => log.warn({ id: row.id, err: (err2 as Error).message }, "tailor_status write failed"),
    );
    return { ok: false, reason };
  }
}
