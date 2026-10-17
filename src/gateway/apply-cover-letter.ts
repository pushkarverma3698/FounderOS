/**
 * Cover letter for /apply
 * ========================
 * The form gets the letter `/draft` wrote when there is one (`cover_letter_s3_key`); otherwise a letter is
 * written and archived now, so a later re-fill or Submit attaches the identical text. Its PDF goes to a
 * cover-letter file field, its text to a cover-letter box (form-brain decides which).
 *
 * Never fatal: no letter costs the letter, not the application. The card says why.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JobApplication } from "../db/schema.js";
import { downloadFile } from "../infra/storage/s3-client.js";
import { renderCvToPdf } from "../tools/jobhunt/cv-renderer.js";
import { labelMatches, type FormPlanSummary, type RowApplicationFacts } from "../tools/jobhunt/form-brain.js";
import { writeCoverLetter } from "./cover-letter-delivery.js";
import { safeHtml } from "./safe-html.js";

export interface ApplyCoverLetter {
  readonly text: string;
  readonly pdfPath: string;
}

export type CoverLetterOutcome =
  | { readonly ok: true; readonly letter: ApplyCoverLetter; readonly source: "archived" | "written" }
  | { readonly ok: false; readonly reason: string };

const MAX_CHAT_LETTER_CHARS = 3500;

/** Named like the tailored CV (`cv-<company>-<id8>.pdf`): the recruiter sees this file name. */
export function coverLetterPdfPath(artifactDir: string, row: Pick<JobApplication, "id" | "company">): string {
  const slug = row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "role";
  return path.join(artifactDir, `cover-letter-${slug}-${row.id.slice(0, 8)}.pdf`);
}

/** The archived letter, else a new one from `cvText`; rendered to PDF in `artifactDir`. */
export async function resolveApplyCoverLetter(
  row: JobApplication,
  cvText: string | null,
  artifactDir: string,
): Promise<CoverLetterOutcome> {
  try {
    let text: string;
    let source: "archived" | "written";
    if (row.cover_letter_s3_key) {
      text = (await downloadFile(row.cover_letter_s3_key)).toString("utf8").trim();
      source = "archived";
    } else {
      if (!cvText) return { ok: false, reason: "no letter on file and the base CV could not be read" };
      const written = await writeCoverLetter(row, cvText);
      if (!written.ok) return { ok: false, reason: written.reason };
      text = written.letter.trim();
      source = "written";
    }
    if (!text) return { ok: false, reason: "the archived letter is empty" };
    const pdfPath = coverLetterPdfPath(artifactDir, row);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(pdfPath, (await renderCvToPdf(text)).pdfBuffer);
    return { ok: true, letter: { text, pdfPath }, source };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export const letterOf = (outcome: CoverLetterOutcome): ApplyCoverLetter | undefined => (outcome.ok ? outcome.letter : undefined);

/** What the form fill needs from a letter, or nothing. */
export function letterFacts(letter: ApplyCoverLetter | undefined): Pick<RowApplicationFacts, "coverLetterPath" | "coverLetterText"> {
  return letter ? { coverLetterPath: letter.pdfPath, coverLetterText: letter.text } : {};
}

/** A cover-letter field, not a combined "Resume/Cover letter" slot (the CV goes there). Same rule as form-brain. */
const isLetterLabel = (label: string): boolean => labelMatches(label, "coverLetter") && !labelMatches(label, "resume");

/** One card line: did the form take the letter, has it no letter field, or why is there no letter. */
export function coverLetterLine(
  letter: ApplyCoverLetter | undefined,
  note: string | undefined,
  summary: Pick<FormPlanSummary, "filledLabels" | "unanswered">,
): string {
  if (!letter) return `⚠ Cover letter: none (${safeHtml(note ?? "not written")}).`;
  const taken = summary.filledLabels.find(isLetterLabel);
  if (taken) return `📄 Cover letter: attached (${safeHtml(taken)}).`;
  const missed = summary.unanswered.find((q) => isLetterLabel(q.label));
  if (missed) return `⚠ Cover letter: the form did not take it (${safeHtml(missed.label)}).`;
  return "📄 Cover letter: this form has no cover-letter field.";
}

/** The letter as one chat message, collapsed, so the founder can read what goes to the company. */
export function coverLetterMessage(company: string, outcome: Extract<CoverLetterOutcome, { ok: true }>): string {
  const from = outcome.source === "archived" ? "the one /draft wrote" : "written now";
  const body = outcome.letter.text.length > MAX_CHAT_LETTER_CHARS ? `${outcome.letter.text.slice(0, MAX_CHAT_LETTER_CHARS)}…` : outcome.letter.text;
  return `📄 <b>Cover letter for ${safeHtml(company)}</b> (${from}; attached where the form takes one)\n<blockquote expandable>${safeHtml(body)}</blockquote>`;
}
