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

export function generateDorks(cleanCompanyName: string): string[] {
  const safeName = cleanCompanyName.replace(/[@#]/g, "");
  const titleClause = `"recruiter"`;

  return [
    // 1. Tightest: LinkedIn profile pages, company name + a recruiting title
    `"linkedin.com/in" "${safeName}" ${titleClause}`,

    // 2. Loosen the title requirement
    `"linkedin.com/in" "${safeName}" "recruiting"`,

    // 3. Drop the site: restriction — small companies with thin LinkedIn SEO
    //    sometimes surface via a different indexed page first
    `"${safeName}" ${titleClause} linkedin`,

    // 4. Last resort: company + generic HR term, no LinkedIn restriction at all
    `"${safeName}" "HR" contact`,
  ];
}
