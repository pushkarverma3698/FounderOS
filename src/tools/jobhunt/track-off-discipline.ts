/**
 * FounderOS — titles led by a non-software discipline
 * ===================================================
 * The free classifier matches generic words ("AI", "Platform", "Linux", "Java
 * developer", "DevOps Engineer") plus a role noun. That is right for "Platform
 * Engineer" and wrong for "Mechanical CAD&Simulation Engineer - AI Trainer",
 * "SAP BODS/BO Platform Admin & Developer" or "Platform Engineer, Atlassian
 * Confluence": the generic word is incidental and a different discipline names the
 * seat. Prod audit 2026-11-03..10 found six such titles passing track matching.
 *
 * These are DISCIPLINE words, not company names: a mechanical / civil / electrical
 * seat, an ERP or enterprise-suite specialism, a kernel, a mainframe, a designer, a
 * KDB+/Q trading stack, a data-labelling gig. Whole-word match, so "Design Systems
 * Engineer" and "Linux Platform" are untouched. Applied to tech profiles only —
 * "SAP" is a finance skill for the finance candidate.
 *
 * Pure: no I/O.
 */

const OFF_DISCIPLINE_TERMS: readonly string[] = [
  "mechanical", "civil", "electrical", "electronics", "hardware", "cad",
  "designer", "ai trainer", "annotator",
  "sap", "abap", "bods", "mainframe", "cobol", "kdb", "salesforce", "servicenow",
  "atlassian", "confluence", "jira",
  "linux kernel", "kernel developer", "kernel engineer",
];

const OFF_DISCIPLINE = new RegExp(
  `(?<![a-z0-9])(?:${OFF_DISCIPLINE_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9])`,
  "i",
);

/** True when a non-software discipline leads the title. */
export function isOffDisciplineTitle(title: string): boolean {
  return OFF_DISCIPLINE.test(title);
}
