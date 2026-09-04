/**
 * FounderOS — CV claim guard
 * ===========================
 * Verifies a tailored CV against the base CV it was generated from, before the
 * tailored version is allowed to leave `tailorCv()`.
 *
 * WHY THIS EXISTS. Until this file, `tailorCv()`'s only defense against
 * fabrication was two lines in a system prompt ("NEVER fabricate job titles,
 * employer names, ... NEVER claim skills ... not actually worked with"). A
 * prompt instruction is a wish, not a guard — this repo's own architecture
 * principle (CLAUDE.md, "Determinism") is that routing/parsing/guards must be
 * pure, unit-tested functions, never prompt instructions. A 2026-08-25
 * measurement found 36 fabricated claims across 4 sampled tailored CVs
 * (invented Kubernetes, PyTorch, Domain-Driven Design and FastAPI experience
 * the base CV never states). `findSlop` runs on every tailoring pass and
 * checks style; nothing checked facts. This does.
 *
 * WHAT THIS CATCHES, deterministically, with no LLM call:
 *   1. Technologies/skills the tailored CV names that `extractSkillTerms`
 *      cannot find anywhere in the base CV.
 *   2. Employers claimed in the tailored CV's work-history headings that
 *      cannot be found (after stripping legal suffixes like "Inc"/"B.V.")
 *      anywhere in the base CV text.
 *   3. Job titles claimed in work-history headings whose defining role word
 *      (e.g. "Engineer", "Director") appears nowhere in the base CV at all.
 *   4. Dates: a 4-digit year named anywhere in the tailored CV, in any of the
 *      formats a CV actually uses (`YYYY`, `Mon YYYY`, `MM/YYYY`), that the
 *      base CV never states in any format.
 *   5. Degrees/certifications named in the tailored CV's EDUCATION or
 *      CERTIFICATIONS section that the base CV's full text never states.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH — false-positive discipline.
 * This function BLOCKS a real application from being sent. A false positive
 * costs a good candidate a real shot at a role, which is a real cost, not a
 * theoretical one, so every check below is biased toward "prove it's
 * fabricated," never "prove it's grounded":
 *   - Reordering, re-emphasizing or paraphrasing existing CV content never
 *     trips a check. Nothing here scores prose or sentence structure — only
 *     named entities (skills, employers, titles, dates, degrees) are
 *     checked, and each is checked against the WHOLE base document, not a
 *     single sentence or bullet. "5 years building distributed systems in
 *     Python" passes as long as "Python" and the role/date facts are stated
 *     ANYWHERE in the base CV, regardless of which sentence they were in.
 *   - Title matching does not require an exact string match: a retitled but
 *     truthful role ("Founding Engineer" tailored to "Founding Software
 *     Engineer" when "software" appears elsewhere on the CV) is not flagged.
 *     Only a title whose defining role word is entirely absent from the
 *     source document is flagged.
 *   - Employer matching strips common legal suffixes before comparing, so
 *     "Turicks" vs "Turicks B.V." is not a false fabrication.
 *   - Degree/certification checking is scoped to the tailored CV's own
 *     EDUCATION/CERTIFICATIONS section. Scanning the whole document for
 *     degree-shaped tokens (e.g. the bare acronym "BA") produced false
 *     positives from unrelated body text with no way to tell them from a
 *     real claim, so that check is intentionally narrower than the others.
 *
 * Pure: no model call, no network, no DB. $0 and deterministic, exactly like
 * `overlapScore` and `extractSkillTerms` in this same directory.
 */

import { extractSkillTerms } from "./skills.js";

export type CvClaimKind = "technology" | "employer" | "title" | "date" | "degree";

export interface CvClaimViolation {
  readonly kind: CvClaimKind;
  readonly claim: string;
  readonly reason: string;
}

export type CvClaimVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly CvClaimViolation[] };

// ── shared helpers ────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase();
}

/** Heading line at any depth, e.g. "## EXPERIENCE" or "### Turicks — Founding Engineer". */
const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;

/**
 * The body text under the first heading matching `keywordRe`, up to (not
 * including) the next heading at the same or shallower depth. Re-opens if a
 * later, non-contiguous heading also matches (e.g. EDUCATION then, after
 * SKILLS, a separate CERTIFICATIONS section) so both contribute.
 *
 * Returns null when no matching heading exists at all — the caller should
 * treat "no such section" as "nothing to check," not as a violation.
 */
function sectionBody(cvText: string, keywordRe: RegExp): string | null {
  const out: string[] = [];
  let capturing = false;
  let openDepth = 0;

  for (const line of cvText.split("\n")) {
    const heading = HEADING_LINE_RE.exec(line);
    if (heading) {
      const depth = (heading[1] as string).length;
      const title = (heading[2] as string).trim();
      if (capturing && depth <= openDepth) capturing = false;
      if (!capturing && keywordRe.test(title)) {
        capturing = true;
        openDepth = depth;
        continue;
      }
    }
    if (capturing) out.push(line);
  }

  return out.length > 0 ? out.join("\n") : null;
}

/** Filler words excluded when comparing free-text claims (titles, certifications) word-by-word. */
const CORE_WORD_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "and", "or", "at", "for", "to", "in", "on", "with",
  "senior", "junior", "lead", "staff", "principal", "associate", "chief",
  "i", "ii", "iii", "iv", "sr", "jr",
  "certified", "certificate", "certification",
]);

/** Content words of a free-text claim, lowercased, stopwords and 1-char tokens removed. */
function coreWords(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 1 && !CORE_WORD_STOPWORDS.has(w));
}

// ── 1. technologies / skills ──────────────────────────────────────────────────

function checkTechnologyClaims(tailored: string, base: string): CvClaimViolation[] {
  const baseTerms = new Set(extractSkillTerms(base).map((s) => s.term));
  const violations: CvClaimViolation[] = [];
  const seen = new Set<string>();

  for (const { term } of extractSkillTerms(tailored)) {
    if (baseTerms.has(term) || seen.has(term)) continue;
    seen.add(term);
    violations.push({
      kind: "technology",
      claim: term,
      reason: `"${term}" appears in the tailored CV but extractSkillTerms finds no mention of it anywhere in the base CV.`,
    });
  }
  return violations;
}

// ── work-history headings, shared by employer + title checks ────────────────

interface WorkHistoryEntry {
  readonly raw: string;
  readonly employer: string;
  readonly title: string | null;
}

const WORK_ENTRY_HEADING_RE = /^###\s+(.+)$/;

/** "Employer — Title" or "Employer - Title"; falls back to the whole heading as the employer. */
function splitHeading(text: string): { employer: string; title: string | null } {
  const emDash = text.indexOf("—");
  if (emDash !== -1) {
    return { employer: text.slice(0, emDash).trim(), title: text.slice(emDash + 1).trim() };
  }
  const dashMatch = /\s[-|]\s/.exec(text);
  if (dashMatch) {
    const idx = dashMatch.index;
    return {
      employer: text.slice(0, idx).trim(),
      title: text.slice(idx + dashMatch[0].length).trim(),
    };
  }
  return { employer: text.trim(), title: null };
}

function extractWorkHistoryEntries(cvText: string): WorkHistoryEntry[] {
  const body = sectionBody(cvText, /experience/i);
  if (!body) return [];

  const entries: WorkHistoryEntry[] = [];
  for (const line of body.split("\n")) {
    const match = WORK_ENTRY_HEADING_RE.exec(line.trim());
    if (!match) continue;
    const raw = (match[1] as string).trim();
    entries.push({ raw, ...splitHeading(raw) });
  }
  return entries;
}

// ── 2. employers ──────────────────────────────────────────────────────────────

/** Legal-entity suffixes stripped before comparing employer names — "Turicks B.V." vs "Turicks" is not a fabrication. */
const EMPLOYER_SUFFIXES = [
  "incorporated", "corporation", "inc", "llc", "ltd", "limited", "corp", "co",
  "gmbh", "bv", "nv", "plc", "sa", "ag", "pvt ltd", "private limited",
];
const EMPLOYER_SUFFIX_RE = new RegExp(`[,\\s]+\\b(?:${EMPLOYER_SUFFIXES.join("|")})\\s*$`, "i");

function coreEmployerName(raw: string): string {
  let name = normalize(raw).replace(/\([^)]*\)/g, " ").replace(/\./g, "").trim();
  for (let i = 0; i < 2; i++) {
    const stripped = name.replace(EMPLOYER_SUFFIX_RE, "").trim();
    if (stripped === name) break;
    name = stripped;
  }
  return name.replace(/,+$/g, "").trim();
}

function checkEmployerClaims(entries: readonly WorkHistoryEntry[], base: string): CvClaimViolation[] {
  const baseLower = normalize(base);
  const violations: CvClaimViolation[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const core = coreEmployerName(entry.employer);
    if (core.length < 3 || seen.has(core)) continue;
    seen.add(core);
    if (!baseLower.includes(core)) {
      violations.push({
        kind: "employer",
        claim: entry.employer,
        reason: `"${entry.employer}" does not appear anywhere in the base CV.`,
      });
    }
  }
  return violations;
}

// ── 3. titles ─────────────────────────────────────────────────────────────────

function checkTitleClaims(entries: readonly WorkHistoryEntry[], base: string): CvClaimViolation[] {
  const baseLower = normalize(base);
  const violations: CvClaimViolation[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.title) continue;
    const key = normalize(entry.title);
    if (seen.has(key)) continue;
    seen.add(key);

    const missing = coreWords(entry.title).filter((w) => !baseLower.includes(w));
    if (missing.length > 0) {
      violations.push({
        kind: "title",
        claim: entry.title,
        reason: `"${entry.title}" contains "${missing.join(", ")}" — not found anywhere in the base CV.`,
      });
    }
  }
  return violations;
}

// ── 4. dates ──────────────────────────────────────────────────────────────────

const MONTH_YEAR_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{4})\b/gi;
const MM_YYYY_RE = /\b(?:0[1-9]|1[0-2])\/(\d{4})\b/g;
const BARE_YEAR_RE = /\b(?:19|20)\d{2}\b/g;

interface DateToken {
  readonly token: string;
  readonly year: string;
}

/** Every date-shaped token, most-specific format first, so a bare year already covered by "Jan 2020" isn't reported twice. */
function extractDateTokens(text: string): DateToken[] {
  const tokens: DateToken[] = [];
  const covered = new Set<number>();

  for (const re of [MONTH_YEAR_RE, MM_YYYY_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ token: m[0], year: m[1] as string });
      for (let i = m.index; i < m.index + m[0].length; i++) covered.add(i);
    }
  }

  BARE_YEAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_YEAR_RE.exec(text)) !== null) {
    if (covered.has(m.index)) continue;
    tokens.push({ token: m[0], year: m[0] });
  }

  return tokens;
}

function checkDateClaims(tailored: string, base: string): CvClaimViolation[] {
  const baseYears = new Set(extractDateTokens(base).map((d) => d.year));
  const violations: CvClaimViolation[] = [];
  const seen = new Set<string>();

  for (const { token, year } of extractDateTokens(tailored)) {
    if (baseYears.has(year) || seen.has(year)) continue;
    seen.add(year);
    violations.push({
      kind: "date",
      claim: token,
      reason: `The year ${year} (from "${token}") does not appear anywhere in the base CV.`,
    });
  }
  return violations;
}

// ── 5. degrees / certifications ───────────────────────────────────────────────

const DEGREE_RE =
  /\b(?:bachelor'?s?(?:\s+of\s+(?:science|arts|engineering|technology))?|master'?s?(?:\s+of\s+(?:science|arts|engineering|technology|business administration))?|mba|ph\.?d\.?|doctorate|b\.?sc\.?|m\.?sc\.?|b\.?tech\.?|m\.?tech\.?)\b/gi;
const CERT_KEYWORD_RE = /\b(?:certified|certificate|certification)\b/i;

function checkDegreeClaims(tailored: string, base: string): CvClaimViolation[] {
  const section = sectionBody(tailored, /education|certificat/i);
  if (!section) return [];

  const baseLower = normalize(base);
  const violations: CvClaimViolation[] = [];
  const seen = new Set<string>();

  // Named degree types, checked as the short canonical phrase rather than the
  // whole line — a reformatted institution or date does not trip this.
  const degreeRe = new RegExp(DEGREE_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = degreeRe.exec(section)) !== null) {
    const phrase = normalize(m[0]);
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    if (!baseLower.includes(phrase)) {
      violations.push({
        kind: "degree",
        claim: m[0],
        reason: `"${m[0]}" appears in the tailored CV's education section but no degree of that type appears anywhere in the base CV.`,
      });
    }
  }

  // Certifications named in prose ("AWS Certified Solutions Architect") — every
  // core word of the line must appear somewhere in the base CV.
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim().replace(/^[-*#\s]+/, "");
    if (line.length === 0 || !CERT_KEYWORD_RE.test(line)) continue;
    const key = normalize(line);
    if (seen.has(key)) continue;
    seen.add(key);

    const missing = coreWords(line).filter((w) => !baseLower.includes(w));
    if (missing.length > 0) {
      violations.push({
        kind: "degree",
        claim: line,
        reason: `"${line}" contains "${missing.join(", ")}" — not found anywhere in the base CV.`,
      });
    }
  }

  return violations;
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Verify every checkable factual claim in a tailored CV against the base CV it
 * was generated from. Pure, deterministic, no LLM call — see the module
 * comment for exactly what is and is not caught.
 */
export function verifyCvClaims(tailoredCvText: string, baseCvText: string): CvClaimVerification {
  const entries = extractWorkHistoryEntries(tailoredCvText);

  const violations: CvClaimViolation[] = [
    ...checkTechnologyClaims(tailoredCvText, baseCvText),
    ...checkEmployerClaims(entries, baseCvText),
    ...checkTitleClaims(entries, baseCvText),
    ...checkDateClaims(tailoredCvText, baseCvText),
    ...checkDegreeClaims(tailoredCvText, baseCvText),
  ];

  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}
