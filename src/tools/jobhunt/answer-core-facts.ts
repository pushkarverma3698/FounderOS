/**
 * FounderOS — keep the dossier facts in step with the structured answers
 * =====================================================================
 * SEMANTIC_RULES (candidate-dossier.ts) read the dossier fact BEFORE the profile field, so editing
 * answers.salary_floor_eur_year alone changed nothing a form would see. These helpers write the changed
 * profile values into the dossier under the labels dossier-template.ts uses.
 *
 * PURE (STANDARDS.md section 2).
 */

import { normalizeQuestionKey } from "./candidate-dossier.js";

type Obj = Readonly<Record<string, unknown>>;

const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const yesNo = (v: unknown): string | undefined => (typeof v === "boolean" ? (v ? "Yes" : "No") : undefined);
const num = (v: unknown): string | undefined => (typeof v === "number" ? String(v) : undefined);
const ans = (p: Obj, key: string): unknown => obj(p["answers"])[key];

/** Core Facts label to the value the profile implies for it (same wording as the starter template). */
const FACT_SOURCES: ReadonlyArray<{ readonly label: string; readonly of: (p: Obj) => string | undefined }> = [
  { label: "First Name", of: (p) => str(p["first_name"]) },
  { label: "Last Name", of: (p) => str(p["last_name"]) },
  { label: "Full Name", of: (p) => (str(p["first_name"]) && str(p["last_name"]) ? `${str(p["first_name"])} ${str(p["last_name"])}` : undefined) },
  { label: "Email", of: (p) => str(p["email"]) },
  { label: "Phone", of: (p) => str(p["phone"]) },
  { label: "LinkedIn", of: (p) => str(p["linkedin"]) },
  { label: "Website", of: (p) => str(p["website"]) },
  { label: "GitHub", of: (p) => str(ans(p, "github")) },
  { label: "City", of: (p) => str(ans(p, "location_city")) },
  { label: "Country", of: (p) => str(ans(p, "location_country")) },
  { label: "Work Authorization", of: (p) => str(ans(p, "work_authorization")) },
  { label: "Work Authorization Detail", of: (p) => str(ans(p, "work_authorization_detail")) },
  { label: "Salary Expectation", of: (p) => num(ans(p, "salary_floor_eur_year")) },
  { label: "Years of Experience", of: (p) => num(ans(p, "years_experience")) },
  {
    label: "Notice Period",
    of: (p) => {
      const days = ans(p, "notice_period_days");
      // The profile rule reads the free-text detail before the day count, so the fact does too.
      return str(ans(p, "notice_period_detail")) ?? (typeof days === "number" ? (days === 0 ? "Immediately" : `${days} days`) : undefined);
    },
  },
  { label: "Willing to Relocate", of: (p) => yesNo(ans(p, "willing_to_relocate")) },
  { label: "Needs Relocation", of: (p) => yesNo(ans(p, "needs_relocation")) },
  { label: "Current Company", of: (p) => str(ans(p, "current_company")) },
  { label: "Current Title", of: (p) => str(ans(p, "current_title")) },
  { label: "Highest Degree", of: (p) => str(ans(p, "highest_degree")) },
  { label: "University", of: (p) => str(ans(p, "university")) },
  { label: "Referral Source", of: (p) => str(ans(p, "referral_source")) },
];

/** The key of a fact line (bold or plain Key: value), or null. Q&A-style keys with a question mark are not facts. */
function factKeyOf(line: string): string | null {
  const t = line.trim();
  const bold = /^[-*•]?\s*\*\*(.+?)\*\*\s*[:=]\s*(.+)$/.exec(t);
  if (bold) return bold[1]!.includes("?") ? null : normalizeQuestionKey(bold[1]!);
  const plain = /^(?:[-*•]\s*)?([^:=?*]+)\s*[:=]\s*(.+)$/.exec(t);
  return plain ? normalizeQuestionKey(plain[1]!) : null;
}

/** markdown with this fact set to value: every existing fact line for the label is rewritten, else one is added to Core Facts. */
export function upsertFact(markdown: string, label: string, value: string): string {
  const wanted = normalizeQuestionKey(label);
  const lines = markdown.replace(/\s+$/, "").split("\n");
  const newLine = `- **${label}**: ${value}`;
  let section = "header";
  let coreStart = -1;
  let coreEnd = lines.length;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(lines[i]!.trim());
    if (heading) {
      if (coreStart !== -1 && coreEnd === lines.length) coreEnd = i;
      section = normalizeQuestionKey(heading[2]!);
      if (section === "core facts" && coreStart === -1) {
        coreStart = i;
        coreEnd = lines.length;
      }
      continue;
    }
    // Same test as parseDossierMarkdown: these sections hold Q&A, not facts.
    if (section.includes("question") || section.includes("learned")) continue;
    if (factKeyOf(lines[i]!) === wanted) {
      lines[i] = newLine;
      replaced = true;
    }
  }
  if (replaced) return `${lines.join("\n")}\n`;
  if (coreStart === -1) {
    const at = lines[0]?.startsWith("#") ? 1 : 0;
    lines.splice(at, 0, "", "## Core Facts", newLine);
    return `${lines.join("\n")}\n`;
  }
  let insertAt = coreEnd;
  while (insertAt > coreStart + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, newLine);
  return `${lines.join("\n")}\n`;
}

/** Write into the dossier every fact whose profile value differs between before and after. */
export function syncCoreFacts(markdown: string, before: Obj, after: Obj): string {
  let md = markdown;
  for (const src of FACT_SOURCES) {
    const next = src.of(after);
    if (next !== undefined && next !== src.of(before)) md = upsertFact(md, src.label, next);
  }
  return md;
}
