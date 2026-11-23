/**
 * Auto-apply tailoring: one tailored CV and one ATS fit check per row, before any send
 * ====================================================================================
 * Called by the shadow pass (shadow-apply.ts) for a row that landed on the auto lane or on a Mac-solvable
 * hand-off. It writes the tailored PDF where `tailoredCvPath` points, so `resolveResumePdf` hands the same file
 * to the VPS send, the Mac packet and the Mini App. The model is the existing chain (tailorCv): no new calls, no
 * paid fallback. Two rules hold everywhere:
 *   - At most one tailorCv call per row, ever. `ats_json` is written after the attempt, success or not, and a
 *     file already on disk also counts as done.
 *   - A tailor failure never blocks the send: the base CV stays, and the record says `failed <reason>`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JobApplication } from "../../db/schema.js";
import { childLogger } from "../../infra/logger.js";
import { tailoredCvPath, MIN_DESCRIPTION_CHARS } from "./apply-packet.js";
import { buildAtsRecord, parseAts, type AtsRecord } from "./ats-record.js";
import { renderCvToPdf } from "./cv-renderer.js";
import { checkPdfText, extractPdfText } from "./pdf-check.js";
import { overlapScore } from "./overlap.js";
import type { JobSearchProfile } from "./profile-config.js";
import { tailorCv } from "./tailor-cv.js";

const log = childLogger({ module: "ats-tailor" });
const DEFAULT_PER_RUN = 20;

/** What this step reads off a row (a full JobApplication satisfies it). */
export type TailorRow = Pick<JobApplication, "id" | "company" | "title" | "track"> & {
  readonly description?: string | null;
  readonly ats_json?: string | null;
};

export interface TailorDeps {
  readonly tailor: typeof tailorCv;
  readonly render: (markdown: string) => Promise<Buffer>;
  /** Plain text of a rendered PDF, as an ATS parser would read it. */
  readonly pdfText: (pdf: Buffer) => Promise<string>;
  readonly fileExists: (filePath: string) => Promise<boolean>;
  readonly writeFile: (filePath: string, data: Buffer) => Promise<void>;
  readonly recordAts: (id: string, atsJson: string) => Promise<void>;
}

/** Tailor calls still allowed in this pass. Shared by every row of the run. */
export interface TailorBudget {
  left: number;
}

export function tailorPerRunCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env["APPLY_TAILOR_PER_RUN"] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PER_RUN;
}

export function realTailorDeps(): TailorDeps {
  return {
    tailor: tailorCv,
    pdfText: extractPdfText,
    render: async (md) => (await renderCvToPdf(md)).pdfBuffer,
    fileExists: async (p) => {
      try {
        const s = await fs.stat(p);
        return s.isFile() && s.size > 0;
      } catch {
        // allow-failopen: a missing file just means "not tailored yet".
        return false;
      }
    },
    writeFile: async (p, data) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, data);
    },
    recordAts: async (id, json) => {
      const { recordAts } = await import("../../db/job-apply-lane-queries.js");
      await recordAts(id, json);
    },
  };
}

async function save(deps: TailorDeps, id: string, ats: AtsRecord): Promise<AtsRecord> {
  try {
    await deps.recordAts(id, JSON.stringify(ats));
  } catch (err) {
    // allow-failopen: the tailored file is already on disk; a lost ATS note must not stop the send.
    log.warn({ rowId: id, err: (err as Error).message }, "ATS record could not be stored");
  }
  return ats;
}

/**
 * The ATS record for one row, tailoring it first when that has never been tried. Returns null when nothing was
 * tried and nothing is on record (run budget spent). Never throws.
 */
export async function tailorForRow(
  deps: TailorDeps,
  row: TailorRow,
  profile: JobSearchProfile,
  artifactDir: string,
  budget: TailorBudget,
): Promise<AtsRecord | null> {
  const prior = parseAts(row.ats_json);
  if (prior) return prior;
  const target = tailoredCvPath(artifactDir, row);
  if (await deps.fileExists(target)) {
    return save(deps, row.id, buildAtsRecord({ ratio: 0, matched: [], missing: [], tailored: true, tailor: "kept existing tailored CV" }));
  }
  const description = row.description?.trim() ?? "";
  if (description.length < MIN_DESCRIPTION_CHARS) {
    return save(deps, row.id, buildAtsRecord({ ratio: 0, matched: [], missing: [], tailored: false, tailor: "failed no usable description" }));
  }
  if (budget.left <= 0) return null;
  budget.left -= 1;

  let ratio = 0;
  let matched: readonly string[] = [];
  let missing: readonly string[] = [];
  let cvTrack: string | undefined;
  try {
    const out = await deps.tailor({ jobDescription: description, companyName: row.company, jobTitle: row.title, track: row.track, profile });
    ratio = out.initialOverlapRatio;
    matched = out.matchedSkills;
    missing = out.missingSkills;
    cvTrack = out.track;
    if (!out.success || !out.tailoredMarkdown) throw new Error(out.error ?? "CV tailoring failed");
    const pdf = await deps.render(out.tailoredMarkdown);
    if (pdf.length === 0) throw new Error("PDF render produced 0 bytes");
    // An ATS reads the PDF, not the markdown: check the name, headings and matched skills survive the render.
    const problem = checkPdfText(await deps.pdfText(pdf).catch(() => ""), out.tailoredMarkdown, matched, profile.skillsDictionaryName);
    if (problem) {
      log.warn({ rowId: row.id, problem }, "Rendered PDF failed the ATS text check");
      throw new Error("pdf parse");
    }
    await deps.writeFile(target, pdf);
    const finalRatio = overlapScore(description, out.tailoredMarkdown, profile.skillsDictionaryName).ratio;
    return save(deps, row.id, buildAtsRecord({ ratio, matched, missing, tailored: true, finalRatio, track: cvTrack }));
  } catch (err) {
    // allow-failopen: a tailor failure keeps the base CV and is recorded; it must never block the send.
    const reason = (err as Error).message;
    log.warn({ rowId: row.id, reason }, "Tailoring failed; the base CV stays");
    return save(deps, row.id, buildAtsRecord({ ratio, matched, missing, tailored: false, tailor: `failed ${reason}`, track: cvTrack }));
  }
}
