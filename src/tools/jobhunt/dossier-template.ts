/**
 * FounderOS — Starter candidate dossier
 * =====================================
 * The Markdown a new candidate's reference dossier starts from (`candidate-dossier.ts` reads it back).
 *
 * PURE (`STANDARDS.md` §2).
 */

import type { ApplyProfile } from "./apply-profile.js";

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
