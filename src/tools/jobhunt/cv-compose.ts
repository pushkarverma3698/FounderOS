/**
 * FounderOS — the locked-body CV composer
 * =======================================
 * Founder direction, 2026-09-15: "The CV only needs to change for the leftover
 * keywords and the Base CV is locked."
 *
 * WHAT THIS REPLACES. `tailorCv` asked the model to regenerate the ENTIRE CV for
 * every posting and then checked the result with `verifyCvClaims`. Both halves
 * of that were wrong in a way that is only visible in production numbers:
 *
 *   · The base CV was not locked in any sense a founder would recognise. The
 *     claim guard checks named technologies, employers, titles, dates and
 *     degrees; every line of prose around them was the model's to rewrite, and
 *     two runs against the same posting produced two different CVs.
 *   · One bad word cost the whole document. Prod 2026-09-07: 21 of 22 tailoring
 *     attempts were rejected outright, each discarding a complete generated CV
 *     over a handful of words pulled out of the job description — against 2
 *     applications ever sent. A repair round recovered some of that; it did not
 *     change the shape of the risk.
 *
 * THE SHAPE NOW. Split the base CV at its summary heading. The model is asked
 * for three lines of summary and nothing else. Everything below is copied byte
 * for byte. The model cannot affect the experience section because it is never
 * shown a way to write one, and `verifyCvClaims` can now only fail on three
 * lines it is cheap to regenerate.
 *
 * WHY THE KEYWORDS ARE NOT INJECTED HERE. The obvious next step — appending the
 * JD's missing terms to the SKILLS line — is deliberately absent. A term the
 * base CV does not state is either a wording gap (the CV says Postgres, the ad
 * says SQL) or a real gap (Java), and only the candidate can tell them apart.
 * Guessing in either direction is the fabrication this pipeline has a whole
 * guard module about. The founder VERIFIES a term by adding it to his base CV,
 * where `extractSkillTerms` grounds it automatically for every future posting;
 * `cv_gaps` is what tells him which terms are worth the decision. One source of
 * truth, and no side-table to drift out of sync with the document itself.
 *
 * Pure: no model call, no network, no DB. $0 and deterministic.
 */

/**
 * The headings a CV actually uses for its opening paragraph.
 *
 * Both registered candidates disagree, and that is the point: Pushkar's CV says
 * `## SUMMARY`, Tashi's says `## PROFILE`. A composer that knew only the first
 * would have handed her whole CV back unsplit, and the failure would have been
 * silent — a "tailored" CV identical to the base, with nothing saying so.
 */
const SUMMARY_HEADING_RE =
  /^(#{1,3})\s*(summary|profile|professional summary|about|about me|objective|career objective|profiel|samenvatting)\s*$/im;

export type CvParts =
  | {
      readonly ok: true;
      /** Everything above the summary heading: the name and the contact block. */
      readonly head: string;
      /** The heading line itself, verbatim, so composing restores the CV's own spelling. */
      readonly heading: string;
      /** The summary text, without its heading. */
      readonly summary: string;
      /** Everything from the next section heading down. Never rewritten. */
      readonly body: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Split a base CV into head / summary / body.
 *
 * REFUSES rather than guesses when there is no summary section. Returning the
 * whole document as `body` would mean the summary is never tailored and nothing
 * reports it; returning it as `summary` would hand the model the entire CV to
 * rewrite, which is the behaviour this module exists to end. A failure here is
 * a fixable fact about a file the founder owns, so it is worth saying out loud.
 */
export function splitCv(markdown: string): CvParts {
  const match = SUMMARY_HEADING_RE.exec(markdown);
  if (!match) {
    return {
      ok: false,
      error:
        "the base CV has no summary section — expected a heading like '## SUMMARY' or " +
        "'## PROFILE'. Add one to the base CV, or the tailored CV would be identical to it.",
    };
  }

  const headingLine = match[0];
  const headingStart = match.index;
  const afterHeading = headingStart + headingLine.length;

  // The summary ends at the NEXT heading of the same level or higher. Scanning
  // from `afterHeading` rather than from 0 is what keeps "executive summary" in
  // an experience bullet from being mistaken for a second summary section.
  const rest = markdown.slice(afterHeading);
  const nextHeading = /^#{1,3}\s+\S/m.exec(rest);
  const summaryEnd = nextHeading ? afterHeading + nextHeading.index : markdown.length;

  const summary = markdown.slice(afterHeading, summaryEnd);
  if (summary.trim().length === 0) {
    return {
      ok: false,
      error:
        `the base CV's "${headingLine.trim()}" section is empty — there is nothing to ` +
        "tailor, and an empty summary is the first thing a recruiter sees.",
    };
  }

  return {
    ok: true,
    head: markdown.slice(0, headingStart),
    heading: headingLine.trim(),
    summary,
    body: markdown.slice(summaryEnd),
  };
}

/**
 * Put the CV back together with a new summary and nothing else changed.
 *
 * `head` and `body` are pasted verbatim — that is the whole contract, and
 * cv-compose.test.ts asserts it line by line rather than by spot-check.
 *
 * The model's own heading is stripped first. Models return "## SUMMARY\n\nText"
 * about as often as "Text", and writing both would leave the CV with the heading
 * twice — which an ATS section parser reads as an empty summary followed by an
 * orphan paragraph.
 */
export function composeCv(parts: Extract<CvParts, { ok: true }>, summary: string): string {
  const cleaned = summary.replace(SUMMARY_HEADING_RE, "").trim();
  // A blank line before the next heading, because that is what the base CV has
  // and `body` begins AT the heading — the separator lived in the summary slice
  // and was trimmed off with it. Without this the composer's own round-trip is
  // not byte-identical, which is the one promise this module makes.
  const gap = parts.body.length > 0 ? "\n\n" : "\n";
  return `${parts.head}${parts.heading}\n\n${cleaned}${gap}${parts.body}`;
}
