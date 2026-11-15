/**
 * Hand-off rows: every answer the bot would have typed, ready to copy
 * ===================================================================
 * Most roles the bot catches sit on forms it must not submit (a CAPTCHA, a DataDome wall, a Workday account).
 * The candidate applies by hand, and the bot's job is to make that fast: one row per answer, label + value,
 * for a Copy button each. Pure: the profile, the dossier and the scraped field list go in, rows come out.
 *
 * Nothing is invented. A fact the profile does not hold gets no row; a work-authorisation answer is only
 * ever the candidate's own stored choice. When the form was scraped, its own labels and field order lead,
 * and every answer the form did not ask for follows, so nothing the candidate stored is hidden.
 */

import { lookupLearnedAnswer, normalizeQuestionKey, type CandidateDossier } from "./candidate-dossier.js";
import type { ApplyProfile } from "./apply-profile.js";

export interface HandoffRow {
  /** Stable within one call (`r0`, `r1`…), used for element ids. */
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly value: string;
}

export interface HandoffScrapedField {
  readonly label: string;
  readonly fieldType: string;
  /** What the bot filled or would fill into it, when it knew. */
  readonly value?: string;
}

export interface HandoffJob {
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly coverLetterText?: string;
}

export const GROUP_ABOUT = "About you";
export const GROUP_FORM = "The form's questions";
export const GROUP_SAVED = "Your saved answers";
export const GROUP_LETTER = "Cover letter";

type Draft = Omit<HandoffRow, "id">;
type Dossier = CandidateDossier | null | undefined;

const WORK_AUTH_TEXT: Readonly<Record<string, string>> = {
  "authorized-no-sponsorship": "Authorised to work here, no visa sponsorship needed",
  "requires-sponsorship": "Needs visa sponsorship",
};

const WORKDAY_HOST = /(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|\.workday\.com$/i;

/** True for a Workday job link: the candidate needs an account per company there. */
export function isWorkdayUrl(url: string): boolean {
  try {
    return WORKDAY_HOST.test(new URL(url).hostname);
  } catch {
    // allow-failopen: an unparseable address is not Workday; the panel just omits the account line.
    return false;
  }
}

const clean = (v: string | undefined): string => (v ?? "").trim();

function noticeValue(profile: ApplyProfile, dossier: Dossier): string {
  const a = profile.answers;
  const days = a?.notice_period_days;
  return clean(dossier?.facts["notice period"]) || clean(dossier?.facts["availability"]) || clean(a?.notice_period_detail) ||
    (days === undefined ? "" : days === 0 ? "Immediately" : `${days} days`);
}

function salaryValue(profile: ApplyProfile, dossier: Dossier): string {
  const floor = profile.answers?.salary_floor_eur_year;
  return clean(dossier?.facts["salary expectation"]) || clean(dossier?.facts["expected salary"]) || clean(dossier?.facts["salary"]) ||
    (floor === undefined ? "" : `${floor} EUR per year`);
}

interface Standard {
  readonly label: string;
  readonly value: string;
  /** Form labels this answer fits; null means it is never matched to a scraped field. */
  readonly fits: RegExp | null;
}

function standardRows(profile: ApplyProfile, dossier: Dossier): Standard[] {
  const a = profile.answers;
  const auth = clean(a?.work_authorization_detail) || WORK_AUTH_TEXT[a?.work_authorization ?? "unknown"] || "";
  const place = [clean(a?.location_city), clean(a?.location_country)].filter(Boolean).join(", ");
  const first = clean(profile.first_name);
  const last = clean(profile.last_name);
  const years = a?.years_experience;
  return [
    { label: "First name", value: first, fits: /first name|given name|voornaam/i },
    { label: "Last name", value: last, fits: /last name|surname|family name|achternaam/i },
    { label: "Full name", value: [first, last].filter(Boolean).join(" "), fits: /^(your |full |legal )?name\b|^naam\b/i },
    { label: "Email", value: clean(profile.email), fits: /e-?mail/i },
    { label: "Phone", value: clean(profile.phone), fits: /phone|mobile|telefoon/i },
    { label: "LinkedIn", value: clean(profile.linkedin), fits: /linkedin/i },
    { label: "City, country", value: place, fits: null },
    { label: "Years of experience", value: years === undefined ? "" : String(years), fits: /years? of (relevant |work |professional )?experience|jaar ervaring/i },
    { label: "Notice period", value: noticeValue(profile, dossier), fits: /notice|opzegtermijn|when can you (start|join)|start date|availability/i },
    { label: "Salary expectation", value: salaryValue(profile, dossier), fits: /salary|compensation|salaris|remuneration/i },
    { label: "Work authorisation", value: auth, fits: /authori[sz]|work permit|right to work|visa|sponsorship|eligible to work/i },
  ];
}

/** Every learned answer: question_bank (the newest entry per question wins), then dossier Q&A not already covered. */
function learnedRows(profile: ApplyProfile, dossier: Dossier): Draft[] {
  const byKey = new Map<string, { label: string; value: string }>();
  for (const [q, v] of Object.entries(profile.question_bank ?? {})) {
    const key = normalizeQuestionKey(q);
    if (key && clean(v)) byKey.set(key, { label: q, value: clean(v) });
  }
  for (const [key, v] of Object.entries(dossier?.qaPairs ?? {})) {
    if (!byKey.has(key) && clean(v)) byKey.set(key, { label: key, value: clean(v) });
  }
  return [...byKey.values()].map((e) => ({ group: GROUP_SAVED, label: e.label, value: e.value }));
}

const FILE_LIKE = new Set(["file", "captcha"]);

interface Scraped {
  readonly rows: Draft[];
  readonly usedStd: ReadonlySet<Standard>;
  readonly usedKeys: ReadonlySet<string>;
}

function scrapedRows(fields: readonly HandoffScrapedField[], std: readonly Standard[], profile: ApplyProfile, dossier: Dossier): Scraped {
  const rows: Draft[] = [];
  const usedStd = new Set<Standard>();
  const usedKeys = new Set<string>();
  for (const f of fields) {
    const label = clean(f.label);
    if (FILE_LIKE.has(f.fieldType) || !label) continue;
    const hit = std.find((s) => s.fits !== null && s.value !== "" && s.fits.test(label));
    const value = hit?.value || clean(f.value) || lookupLearnedAnswer(label, undefined, profile, dossier ?? undefined)?.value || "";
    if (!value) continue;
    if (hit) usedStd.add(hit);
    usedKeys.add(normalizeQuestionKey(label));
    rows.push({ group: GROUP_FORM, label, value });
  }
  return { rows, usedStd, usedKeys };
}

/**
 * The rows for one role. With `scrapedFields` (the form was read) the form's labels and order come first;
 * without them the standard order applies. Empty values never make a row. The cover letter is the last row.
 */
export function buildHandoffRows(
  profile: ApplyProfile,
  dossier: Dossier,
  scrapedFields: readonly HandoffScrapedField[] | undefined,
  job: HandoffJob,
): HandoffRow[] {
  const std = standardRows(profile, dossier);
  const learned = learnedRows(profile, dossier);
  const drafts: Draft[] = [];
  if (scrapedFields && scrapedFields.length > 0) {
    const scraped = scrapedRows(scrapedFields, std, profile, dossier);
    drafts.push(...scraped.rows);
    for (const s of std) if (s.value && !scraped.usedStd.has(s)) drafts.push({ group: GROUP_ABOUT, label: s.label, value: s.value });
    for (const l of learned) if (!scraped.usedKeys.has(normalizeQuestionKey(l.label))) drafts.push(l);
  } else {
    for (const s of std) if (s.value) drafts.push({ group: GROUP_ABOUT, label: s.label, value: s.value });
    drafts.push(...learned);
  }
  const letter = clean(job.coverLetterText);
  if (letter) drafts.push({ group: GROUP_LETTER, label: `Cover letter for ${job.company}`, value: letter });
  return drafts.map((d, i) => ({ id: `r${i}`, ...d }));
}
