// src/tools/b2b/dork-generator.ts

// Ordered, most-specific-first. The controller stops querying for a company
// the instant one of these returns a result that clears the accept threshold.
//
// This also replaces the original plan's "EMPTY -> LLM rewrites the query"
// step. A search coming back empty doesn't need a model to decide the next
// move — a fixed, progressively looser chain of templates does the same job
// deterministically and for free.

const RECRUITING_TITLES = [
  "recruiter",
  "talent acquisition",
  "technical recruiter",
  "people operations",
  "hr business partner",
  "human resources",
];

import type { TargetRole } from "./rule-extractor";

export function generateDorks(cleanCompanyName: string, target: TargetRole = "hr"): string[] {
  const safeName = cleanCompanyName.replace(/[@#]/g, "");

  if (target === "hr") {
    return [
      // 1. Tightest: LinkedIn profile pages, company name + a recruiting title
      `"linkedin.com/in" "${safeName}" "recruiter"`,
      // 2. Loosen the title requirement
      `"linkedin.com/in" "${safeName}" "recruiting"`,
      // 3. Drop the site: restriction — small companies with thin LinkedIn SEO
      `"${safeName}" "recruiter" linkedin`,
      // 4. Last resort: company + generic HR term, no LinkedIn restriction at all
      `"${safeName}" "HR" contact`,
    ];
  }

  // TargetRole === "leadership"
  return [
    `"linkedin.com/in" "${safeName}" "Founder"`,
    `"linkedin.com/in" "${safeName}" "CEO"`,
    `"linkedin.com/in" "${safeName}" "Owner"`,
    `"linkedin.com/in" "${safeName}" "Managing Director"`,
    // Looser fallback for leadership
    `"${safeName}" "Founder" linkedin`,
    `"${safeName}" "Owner" contact`,
  ];
}
