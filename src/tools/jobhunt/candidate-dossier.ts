/**
 * FounderOS — Candidate Reference Dossier & Learned Question Bank
 * ===============================================================
 * One reference document per candidate (`candidate-dossier.md` for default,
 * `candidate-dossier-<profileId>.md` for any other profile) plus a learned
 * `question_bank` in `apply-profile-<profileId>.json`.
 *
 * Pure parsing, normalisation, and option matching live at the top; file I/O
 * sits at the bottom (`STANDARDS.md` §2).
 */

import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APPLY_PROFILE_PATH,
  applyProfilePathFor,
  readApplyProfile,
  writeApplyProfile,
  type ApplyProfile,
} from "./apply-profile.js";
import { DEFAULT_PROFILE_ID } from "./profile-config.js";

/** Minimum option text length for substring matching to avoid single-letter collisions. */
export const MIN_SUBSTRING_MATCH_CHARS = 3;

export interface CandidateDossier {
  readonly facts: Readonly<Record<string, string>>;
  readonly qaPairs: Readonly<Record<string, string>>;
  readonly sections: Readonly<Record<string, string>>;
  readonly rawText: string;
}

export interface LearnedMatch {
  readonly kind: "value" | "choose";
  readonly value: string;
  readonly source: string;
}

/**
 * Where a candidate's reference dossier markdown lives on disk.
 * Scoped per `profileId` so Pushkar, Tashi, and any future candidate stay isolated.
 */
export function candidateDossierPathFor(profileId: string = DEFAULT_PROFILE_ID): string {
  const baseProfile = process.env["APPLY_PROFILE_PATH"]?.trim() || APPLY_PROFILE_PATH;
  const dir = dirname(baseProfile);
  return profileId === DEFAULT_PROFILE_ID
    ? join(dir, "candidate-dossier.md")
    : join(dir, `candidate-dossier-${profileId}.md`);
}

/** Normalise a form question or label into a stable lookup key. */
export function normalizeQuestionKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\((?:required|optional|verplicht|optioneel)\)/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PLACEHOLDER_OPTION = /^(?:select\b|please select|choose\b|--|none\b|n\/a$)/i;

/**
 * Match a desired answer string against a closed list of form options (`<select>`, radio, checkbox).
 * Returns the exact option text when unambiguous, or `null` when 0 or 2+ options match.
 */
export function matchChoiceOption(desiredAnswer: string, options: readonly string[]): string | null {
  const cleanDesired = desiredAnswer.trim();
  if (!cleanDesired) return null;
  const normDesired = normalizeQuestionKey(cleanDesired);
  const realOptions = options.map((o) => o.trim()).filter((o) => o.length > 0 && !PLACEHOLDER_OPTION.test(o));
  if (realOptions.length === 0) return null;

  const exact = realOptions.filter(
    (o) => o.toLowerCase() === cleanDesired.toLowerCase() || normalizeQuestionKey(o) === normDesired,
  );
  if (exact.length === 1) return exact[0]!;

  const isYes = /^(?:yes|true|ja|y)$/i.test(normDesired);
  const isNo = /^(?:no|false|nee|n)$/i.test(normDesired);
  if (isYes || isNo) {
    const prefix = isYes ? /^(?:yes|ja)\b/i : /^(?:no|nee)\b/i;
    const boolMatches = realOptions.filter((o) => prefix.test(o));
    if (boolMatches.length === 1) return boolMatches[0]!;
  }

  if (normDesired.length >= MIN_SUBSTRING_MATCH_CHARS) {
    const subMatches = realOptions.filter((o) => {
      const normOpt = normalizeQuestionKey(o);
      return normOpt.includes(normDesired) || (normOpt.length >= MIN_SUBSTRING_MATCH_CHARS && normDesired.includes(normOpt));
    });
    if (subMatches.length === 1) return subMatches[0]!;
    // "India" also hits "British Indian Ocean Territory": keep the options naming it as a whole word.
    const wholeWord = subMatches.filter((o) => ` ${normalizeQuestionKey(o)} `.includes(` ${normDesired} `));
    if (wholeWord.length === 1) return wholeWord[0]!;
  }

  return null;
}

/** Parse a candidate reference dossier Markdown document into structured facts, Q&As, and sections. */
export function parseDossierMarkdown(markdown: string): CandidateDossier {
  const facts: Record<string, string> = {};
  const qaPairs: Record<string, string> = {};
  const sections: Record<string, string> = {};

  let currentSection = "header";
  const sectionLines: Record<string, string[]> = { header: [] };
  let pendingQuestion: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      currentSection = normalizeQuestionKey(headingMatch[2]!);
      sectionLines[currentSection] ??= [];
      pendingQuestion = null;
      continue;
    }

    sectionLines[currentSection] ??= [];
    sectionLines[currentSection]!.push(rawLine);
    if (!line) continue;

    const qMatch = /^(?:[-*]\s*)?(?:\*\*?)?q(?:uestion)?(?:\*\*?)?\s*:\s*(.+)$/i.exec(line);
    if (qMatch) {
      pendingQuestion = normalizeQuestionKey(qMatch[1]!);
      continue;
    }
    const aMatch = /^(?:[-*]\s*)?(?:\*\*?)?a(?:nswer)?(?:\*\*?)?\s*:\s*(.+)$/i.exec(line);
    if (aMatch && pendingQuestion) {
      qaPairs[pendingQuestion] = aMatch[1]!.trim();
      pendingQuestion = null;
      continue;
    }

    const kvMatch = /^(?:[-*•]\s*)?(?:\*\*([^*]+)\*\*|([^:=?]+(?:\?)?))\s*[:=]\s*(.+)$/.exec(line);
    if (kvMatch) {
      const rawKey = (kvMatch[1] ?? kvMatch[2] ?? "").trim();
      const val = kvMatch[3]!.trim();
      const normKey = normalizeQuestionKey(rawKey);
      if (normKey && val) {
        if (rawKey.includes("?") || currentSection.includes("question") || currentSection.includes("learned")) {
          qaPairs[normKey] = val;
        } else {
          facts[normKey] = val;
          qaPairs[normKey] = val;
        }
      }
    }
  }

  for (const [sec, lines] of Object.entries(sectionLines)) {
    const joined = lines.join("\n").trim();
    if (joined) sections[sec] = joined;
  }

  return { facts, qaPairs, sections, rawText: markdown };
}

const SEMANTIC_RULES: ReadonlyArray<{
  readonly name: string;
  readonly phrases: readonly string[];
  /** Phrases that veto the rule ("current base salary" is not the salary expectation). */
  readonly excludes?: readonly string[];
  readonly resolve: (profile: ApplyProfile, dossier?: CandidateDossier) => string | undefined;
}> = [
  {
    name: "noticePeriod",
    phrases: ["notice period", "opzegtermijn", "when can you start", "earliest start date", "start date", "availability", "beschikbaar"],
    resolve: (p, d) =>
      d?.facts["notice period"] ??
      d?.facts["availability"] ??
      p.answers?.notice_period_detail ??
      (p.answers?.notice_period_days !== undefined
        ? p.answers.notice_period_days === 0 ? "Immediately" : `${p.answers.notice_period_days} days`
        : undefined),
  },
  {
    name: "salary",
    phrases: ["salary", "compensation", "pay expectation", "remuneration", "salaris", "salarisindicatie", "gross annual"],
    excludes: ["current"],
    resolve: (p, d) =>
      d?.facts["salary expectation"] ??
      d?.facts["expected salary"] ??
      d?.facts["salary"] ??
      (p.answers?.salary_floor_eur_year !== undefined ? String(p.answers.salary_floor_eur_year) : undefined),
  },
  {
    name: "willingToRelocate",
    phrases: ["willing to relocate", "open to relocation", "relocate to", "bereid om te verhuizen"],
    resolve: (p, d) =>
      d?.facts["willing to relocate"] ??
      (p.answers?.willing_to_relocate !== undefined ? (p.answers.willing_to_relocate ? "Yes" : "No") : undefined),
  },
  {
    name: "needsRelocation",
    phrases: ["need relocation", "require relocation", "relocation assistance", "relocation support"],
    resolve: (p, d) =>
      d?.facts["needs relocation"] ??
      (p.answers?.needs_relocation !== undefined ? (p.answers.needs_relocation ? "Yes" : "No") : undefined),
  },
  {
    name: "github",
    phrases: ["github", "git profile", "code repository"],
    resolve: (p, d) =>
      p.answers?.github ?? d?.facts["github"] ?? (p.website?.toLowerCase().includes("github.com") ? p.website : undefined),
  },
  {
    name: "currentCompany",
    phrases: ["current company", "current employer", "present employer", "huidige werkgever", "most recent employer"],
    resolve: (p, d) => p.answers?.current_company ?? d?.facts["current company"] ?? d?.facts["current employer"],
  },
  {
    name: "currentTitle",
    phrases: ["current title", "current role", "current job title", "present title", "huidige functie"],
    resolve: (p, d) => p.answers?.current_title ?? d?.facts["current title"] ?? d?.facts["current role"],
  },
  {
    name: "highestDegree",
    phrases: ["highest degree", "level of education", "highest education", "education level", "opleidingsniveau"],
    resolve: (p, d) => p.answers?.highest_degree ?? d?.facts["highest degree"] ?? d?.facts["education"],
  },
  {
    name: "university",
    phrases: ["university", "school", "college", "alma mater", "universiteit", "hogeschool"],
    resolve: (p, d) => p.answers?.university ?? d?.facts["university"],
  },
  {
    name: "city",
    phrases: ["city", "current city", "stad", "woonplaats"],
    resolve: (p, d) => p.answers?.location_city ?? d?.facts["city"] ?? d?.facts["location city"],
  },
  {
    name: "country",
    phrases: ["country", "country of residence", "land"],
    resolve: (p, d) => p.answers?.location_country ?? d?.facts["country"] ?? d?.facts["location country"],
  },
  {
    name: "referralSource",
    phrases: ["how did you hear", "where did you hear", "how did you find", "source", "hoe heb je ons gevonden"],
    excludes: ["open source"],
    resolve: (p, d) => p.answers?.referral_source ?? d?.facts["how did you hear about us"] ?? d?.facts["referral source"],
  },
];

/** The candidate's own answer to exactly this question: `question_bank` first, then the dossier. */
export function explicitAnswerFor(
  question: string,
  profile: ApplyProfile,
  dossier?: CandidateDossier,
): { readonly value: string; readonly source: string } | null {
  const normKey = normalizeQuestionKey(question);
  if (!normKey) return null;
  for (const [k, v] of Object.entries(profile.question_bank ?? {})) {
    if (normalizeQuestionKey(k) === normKey && v.trim()) return { value: v.trim(), source: `question_bank ("${k}")` };
  }
  const qa = dossier?.qaPairs[normKey]?.trim();
  if (qa) return { value: qa, source: `dossier Q&A ("${normKey}")` };
  const fact = dossier?.facts[normKey]?.trim();
  return fact ? { value: fact, source: `dossier fact ("${normKey}")` } : null;
}

/** A phrase matches at a word start, so "city" never fires inside "ethnicity". */
const hasPhrase = (normKey: string, phrase: string): boolean => ` ${normKey}`.includes(` ${phrase}`);

/** Look up an answer for `question` from `question_bank`, `dossier`, or `profile.answers`. */
export function lookupLearnedAnswer(
  question: string,
  options: readonly string[] | undefined,
  profile: ApplyProfile,
  dossier?: CandidateDossier,
): LearnedMatch | null {
  const normKey = normalizeQuestionKey(question);
  if (!normKey) return null;

  const explicit = explicitAnswerFor(question, profile, dossier);
  let rawAnswer = explicit?.value;
  let source = explicit?.source ?? "";

  if (!rawAnswer) {
    for (const rule of SEMANTIC_RULES) {
      if (rule.phrases.some((p) => hasPhrase(normKey, p)) && !rule.excludes?.some((p) => hasPhrase(normKey, p))) {
        const resolved = rule.resolve(profile, dossier);
        if (resolved && resolved.trim()) {
          rawAnswer = resolved.trim();
          source = `dossier/profile rule (${rule.name})`;
          break;
        }
      }
    }
  }

  if (!rawAnswer) return null;

  if (options && options.length > 0) {
    const chosen = matchChoiceOption(rawAnswer, options);
    return chosen ? { kind: "choose", value: chosen, source } : null;
  }

  return { kind: "value", value: rawAnswer, source };
}

/** Generate a starter Markdown reference dossier from a candidate's `ApplyProfile`. */
export function buildDefaultDossierMarkdown(profile: ApplyProfile): string {
  const a = profile.answers ?? {};
  const lines = [
    `# Candidate Reference Dossier — ${profile.first_name} ${profile.last_name}`,
    "",
    "## Core Facts",
    `- **First Name**: ${profile.first_name}`,
    `- **Last Name**: ${profile.last_name}`,
    `- **Full Name**: ${profile.first_name} ${profile.last_name}`,
    `- **Email**: ${profile.email}`,
    `- **Phone**: ${profile.phone}`,
    ...(profile.linkedin ? [`- **LinkedIn**: ${profile.linkedin}`] : []),
    ...(profile.website ? [`- **Website**: ${profile.website}`] : []),
    ...(a.github ? [`- **GitHub**: ${a.github}`] : []),
    ...(a.location_city ? [`- **City**: ${a.location_city}`] : []),
    ...(a.location_country ? [`- **Country**: ${a.location_country}`] : []),
    `- **Work Authorization**: ${a.work_authorization ?? "unknown"}`,
    ...(a.work_authorization_detail ? [`- **Work Authorization Detail**: ${a.work_authorization_detail}`] : []),
    ...(a.salary_floor_eur_year !== undefined ? [`- **Salary Expectation**: ${a.salary_floor_eur_year}`] : []),
    ...(a.years_experience !== undefined ? [`- **Years of Experience**: ${a.years_experience}`] : []),
    ...(a.notice_period_days !== undefined ? [`- **Notice Period**: ${a.notice_period_days === 0 ? "Immediately" : `${a.notice_period_days} days`}`] : []),
    ...(a.willing_to_relocate !== undefined ? [`- **Willing to Relocate**: ${a.willing_to_relocate ? "Yes" : "No"}`] : []),
    ...(a.needs_relocation !== undefined ? [`- **Needs Relocation**: ${a.needs_relocation ? "Yes" : "No"}`] : []),
    ...(a.current_company ? [`- **Current Company**: ${a.current_company}`] : []),
    ...(a.current_title ? [`- **Current Title**: ${a.current_title}`] : []),
    ...(a.highest_degree ? [`- **Highest Degree**: ${a.highest_degree}`] : []),
    ...(a.university ? [`- **University**: ${a.university}`] : []),
    ...(a.referral_source ? [`- **Referral Source**: ${a.referral_source}`] : []),
    "",
    "## Learned Form Answers",
  ];
  for (const [q, ans] of Object.entries(profile.question_bank ?? {})) {
    lines.push(`- **${q}**: ${ans}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function readCandidateDossier(profileId: string = DEFAULT_PROFILE_ID): Promise<CandidateDossier | null> {
  try {
    const text = await fs.readFile(candidateDossierPathFor(profileId), "utf8");
    return parseDossierMarkdown(text);
  } catch {
    return null;
  }
}

export async function writeCandidateDossier(profileId: string, markdown: string): Promise<string> {
  const path = candidateDossierPathFor(profileId);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, { mode: 0o600 });
  return path;
}

export async function recordLearnedAnswer(profileId: string, question: string, answer: string): Promise<void> {
  const cleanQ = question.trim();
  const cleanA = answer.trim();
  if (!cleanQ || !cleanA) return;

  const profilePath = applyProfilePathFor(profileId);
  const current = await readApplyProfile(profilePath);
  if (current.ok) {
    const existingBank =
      typeof current.raw["question_bank"] === "object" && current.raw["question_bank"] !== null
        ? (current.raw["question_bank"] as Record<string, string>)
        : {};
    await writeApplyProfile(
      { ...current.raw, question_bank: { ...existingBank, [cleanQ]: cleanA } },
      profilePath,
    );
  }

  const dossierPath = candidateDossierPathFor(profileId);
  const existingMd = await fs
    .readFile(dossierPath, "utf8")
    // allow-failopen: when no dossier file exists yet on disk, initialize it from the profile or header.
    .catch(() => (current.ok ? buildDefaultDossierMarkdown(current.profile) : `# Candidate Reference Dossier (${profileId})\n\n## Learned Form Answers\n`));

  const line = `- **${cleanQ}**: ${cleanA}`;
  if (!existingMd.includes(line)) {
    const updated = existingMd.includes("## Learned Form Answers")
      ? `${existingMd.trimEnd()}\n${line}\n`
      : `${existingMd.trimEnd()}\n\n## Learned Form Answers\n${line}\n`;
    await writeCandidateDossier(profileId, updated);
  }
}
