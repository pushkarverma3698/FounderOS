/**
 * Can an ATS read this PDF? (text extraction + three checks)
 * ===========================================================
 * Applicant tracking systems parse the PDF text layer. After a render we extract that text and require that the
 * candidate's name, every section heading and every matched skill come back. `checkPdfText` is pure; only
 * `extractPdfText` touches the PDF library (unpdf, pure JS, so it also runs on the VPS where pdftotext is absent).
 */

import { extractSkillTerms } from "./skills.js";

export async function extractPdfText(pdf: Buffer): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

const norm = (s: string): string => s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/** Null when the text passes, else what is missing (for the log). */
export function checkPdfText(
  pdfText: string,
  markdown: string,
  matchedSkills: readonly string[],
  dictionaryName = "tech",
): string | null {
  const text = norm(pdfText);
  if (text.length === 0) return "no text extracted";
  const headings = markdown.split("\n").filter((l) => /^#{1,3}\s+\S/.test(l));
  const name = headings.find((l) => /^#\s/.test(l));
  const missing: string[] = [];
  if (name && !text.includes(norm(name.replace(/^#+\s*/, "")))) missing.push(`name "${name.replace(/^#+\s*/, "")}"`);
  for (const h of headings) {
    if (h === name) continue;
    const label = norm(h.replace(/^#+\s*/, ""));
    if (label && !text.includes(label)) missing.push(`heading "${label}"`);
  }
  const found = new Set(extractSkillTerms(pdfText, dictionaryName).map((s) => s.term));
  for (const skill of matchedSkills) if (!found.has(skill)) missing.push(`skill "${skill}"`);
  return missing.length ? `missing ${missing.join(", ")}` : null;
}
