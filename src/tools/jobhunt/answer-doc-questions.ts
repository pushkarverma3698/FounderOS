/**
 * FounderOS — the 50-question answer document, as data
 * ====================================================
 * `job-auto-apply/docs/tashi-questions.md` is what a candidate fills in. The parser matches her lines against
 * these stems (so renumbering and answers on the question line still work); the mapper reads `target` to decide
 * where each answer lands. `key` is the dossier question label the answer is stored under, worded like the form
 * question it will meet, because the learned-answer lookup compares normalised text exactly.
 *
 * PURE (`STANDARDS.md` §2).
 */

export type AnswerTarget =
  | "name" | "email" | "phone" | "location" | "linkedin"
  | "nl-allowed" | "nl-sponsor" | "nl-permit" | "in-allowed"
  | "notice" | "relocate" | "salary-nl" | "years-total" | "title-employer" | "degree" | "referral"
  | "self-gender" | "self-disability" | "self-race"
  | "qa";

export interface DocQuestion {
  readonly n: number;
  /** The template wording the parser matches against. */
  readonly stem: string;
  /** Dossier label for a `qa` answer, and the label shown in previews. */
  readonly key: string;
  readonly target: AnswerTarget;
}

const q = (n: number, stem: string, key: string, target: AnswerTarget = "qa"): DocQuestion => ({ n, stem, key, target });

export const ANSWER_DOC_QUESTIONS: readonly DocQuestion[] = [
  q(1, "Full name exactly as it should appear on applications.", "Full name", "name"),
  q(2, "Email address to use for job applications.", "Email", "email"),
  q(3, "Phone number with country code.", "Phone", "phone"),
  q(4, "Current city and country.", "Current city and country", "location"),
  q(5, "Full postal address (some forms require it).", "Postal address"),
  q(6, "LinkedIn profile link.", "LinkedIn", "linkedin"),
  q(7, "Which CV file should be sent? If you use different CVs for different roles, say which one goes with which role.", "Which CV should be sent"),
  q(8, "Netherlands: are you legally allowed to work there today? (yes / no)", "Netherlands right to work", "nl-allowed"),
  q(9, "Netherlands: do you need the employer to sponsor a visa or work permit, now or in the future? (yes / no)", "Netherlands sponsorship", "nl-sponsor"),
  q(10, "Netherlands: what is your permit type, and until when is it valid?", "Netherlands permit", "nl-permit"),
  q(11, "India: are you legally allowed to work there? (yes / no)", "India right to work", "in-allowed"),
  q(12, "Nationality or citizenship (many Workday forms ask).", "Nationality"),
  q(13, "Are you employed right now? (yes / no)", "Are you currently employed?"),
  q(14, "Notice period in days.", "Notice period", "notice"),
  q(15, "Earliest date you can start.", "Earliest start date"),
  q(16, "Are you willing to relocate? If yes, to which cities or countries?", "Are you willing to relocate?", "relocate"),
  q(17, "Which do you accept: on-site, hybrid, remote? How many office days a week is your limit?", "Work arrangement (on-site, hybrid, remote)"),
  q(18, "How far are you willing to travel for work? (for example: none, up to 25%)", "Willingness to travel"),
  q(19, "Full-time only, or part-time too? If part-time, how many hours a week at least?", "Full-time or part-time"),
  q(20, "Current salary, with currency, and say whether it is per year or per month. Write \"skip\" if you do not want it shared.", "Current salary"),
  q(21, "Expected salary for the Netherlands (gross, per year or per month).", "Expected salary Netherlands", "salary-nl"),
  q(22, "Expected salary for India (per year).", "Expected salary India"),
  q(23, "Total years of work experience.", "Total years of work experience", "years-total"),
  q(24, "Years of experience in finance or accounting.", "Years of experience in finance or accounting"),
  q(25, "Years of experience in each of these (write 0 if none): financial reporting, FP&A or budgeting, accounts payable or receivable, audit, tax, controlling.", "Years of experience by finance area"),
  q(26, "Software you have used and how well (basic / good / expert): Excel, SAP, Oracle, Power BI, Tally, QuickBooks, any other ERP.", "Software skills"),
  q(27, "Current or most recent job title and employer.", "Current or most recent job title and employer", "title-employer"),
  q(28, "Have you ever worked for a company you might apply to, or one of its subsidiaries? Name them, so the bot can answer \"have you worked for us before\" correctly.", "Have you worked for us before?"),
  q(29, "Highest degree, subject, university and graduation year.", "Highest degree", "degree"),
  q(30, "Professional qualifications, finished or in progress (for example CA, ACCA, CPA, CMA, CFA). For any in progress, say how far along you are.", "Professional qualifications"),
  q(31, "English level (basic / professional / fluent / native).", "English level"),
  q(32, "Dutch level (none / A1 / A2 / B1 / B2 / C1 / fluent). Are you taking lessons?", "Dutch level"),
  q(33, "Any other languages and their level.", "Other languages"),
  q(34, "\"How did you hear about this job?\" What should the default answer be? (for example: company careers page)", "How did you hear about this job?", "referral"),
  q(35, "Do you have a relative or close friend working at any company you might apply to? If yes, name the company.", "Do you have a relative or friend working here?"),
  q(36, "Are you bound by a non-compete or similar agreement? (yes / no)", "Are you bound by a non-compete agreement?"),
  q(37, "Do you agree to employers keeping your data for future openings? (yes / no)", "Do you agree to us keeping your data for future openings?"),
  q(38, "Do you agree to background and reference checks? (yes / no)", "Do you agree to background and reference checks?"),
  q(39, "Gender: your answer, or \"prefer not to say\".", "Gender", "self-gender"),
  q(40, "Disability: yes / no / prefer not to say.", "Disability", "self-disability"),
  q(41, "Ethnicity (asked on some forms, mostly US companies): your answer, or \"prefer not to say\".", "Ethnicity", "self-race"),
  q(42, "Why are you looking for a new role?", "Why are you looking for a new role?"),
  q(43, "What kind of finance role do you want next, and why?", "What kind of finance role do you want next, and why?"),
  q(44, "Describe one piece of work you are proud of, and its result. Use real numbers only.", "Describe one piece of work you are proud of"),
  q(45, "What are your strongest skills, in your own words?", "What are your strongest skills?"),
  q(46, "Is there anything an employer should know that is not on your CV (a career gap, a move, a change of field)?", "Is there anything else an employer should know?"),
  q(47, "Any companies or industries you do not want to apply to?", "Companies or industries to avoid"),
  q(48, "Any role types you do not want (for example: call-centre finance, night shifts, internships)?", "Role types to avoid"),
  q(49, "The lowest level you would accept (junior / mid / senior), and the highest you want to be put forward for.", "Seniority range"),
  q(50, "Should the bot send an application without asking you first when every answer on the form comes from this document? (yes / no)", "Send applications without asking first"),
];

/** The template's section titles: a bare "2. Right to work" line is a heading, not question 2. */
export const ANSWER_DOC_SECTIONS: readonly string[] = [
  "basics", "right to work", "availability", "pay", "experience", "education and certificates",
  "languages", "standard form questions", "optional diversity questions", "short written answers", "your limits",
];
