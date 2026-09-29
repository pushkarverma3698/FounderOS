/**
 * Evolution Engine — what an executor is told for the two jobhunt kinds that
 * have an implementation fix.
 * ===========================================================================
 * Split out of issue-body.ts for its 400-line budget, and because these two kinds
 * differ from the code-health ones in a way that changes every paragraph: their
 * evidence is PRODUCTION DATA the executor cannot query. So the body quotes the
 * rows (issue-body.ts prints `Finding.evidenceRows`), says outright that
 * `pnpm audit:self` will not reproduce the finding, and points at the component to
 * read and the test to write instead of at a reproduction it cannot run.
 *
 * `lane-silent` and `candidate-not-acting` are absent ON PURPOSE. "Is this
 * candidate seeing her brief" and "is the lane's market flat" are questions for
 * the founder, not code: an executor handed either would invent a change to look
 * productive. Their absence is what makes `isDispatchable` refuse them.
 *
 * Every backticked path below must exist in the checkout (the auto-issue lint
 * rejects a body naming one that does not); jobhunt-issue-body.test.ts holds the
 * rendered text to that.
 */

import { ADAPTER_SOURCE_PATHS } from "./analyzers/jobhunt.js";
import type { KindGuidance } from "./issue-body.js";
import type { Finding, FindingKind } from "./types.js";

/** The platform an adapter-silent / apply-link finding is about: the subject's first word. */
function platformOf(finding: Finding): string {
  return finding.subject.split(" ")[0] ?? finding.subject;
}

/** Where the executor is told the finding came from. Replaces the code-analyzer sentence. */
const ORIGIN =
  "> Filed automatically by the FounderOS daily jobhunt check (`src/evolution/jobhunt-check.ts`). Nobody wrote this " +
  "by hand — the finding below was computed by `src/evolution/analyzers/jobhunt.ts` from production rows, and you " +
  "have no access to that database: the counts and rows quoted under Evidence are the data it used.";

const ADAPTER_FIXTURE_TESTS =
  "tests/unit/jobhunt/adapters.test.ts tests/unit/jobhunt/adapters-batch2.test.ts " +
  "tests/unit/jobhunt/smartrecruiters-workable.test.ts";

export const JOBHUNT_GUIDANCE: Partial<Record<FindingKind, KindGuidance>> = {
  "adapter-silent": {
    origin: ORIGIN,
    goal: (f) =>
      `The \`${platformOf(f)}\` adapter has stopped yielding postings: 0 new postings in 24 hours after a steady ` +
      `7-day baseline, while the rest of the free lane keeps producing and ${platformOf(f)}'s boards keep answering ` +
      `at the HTTP level. Done means the adapter's \`listJobs\` reads a CURRENT ${platformOf(f)} payload again, ` +
      `proven by a fixture test built from a real, saved payload that fails before the fix.`,
    expected: (f) =>
      `\`listJobs\` in \`${f.location}\` returns the postings a current ${platformOf(f)} payload contains ` +
      `(title, url, location, external id) instead of an empty list, and a payload that genuinely holds no jobs ` +
      `still returns an empty list rather than throwing.`,
    reproduce: (f) =>
      `You cannot re-run the analyzer, and \`pnpm audit:self\` does not run it. Reproduce the CAUSE instead: ` +
      `build the board URL for ${platformOf(f)} with \`getBoardUrl\` from the adapter named under Location, fetch it once ` +
      `with \`curl\` (it is a public, unauthenticated endpoint), and run the adapter's \`listJobs\` over the response. ` +
      `An empty list for a payload that visibly contains jobs is the defect. If it parses fine, the finding was a ` +
      `lull: say so with the curl output and close the issue instead of inventing a change.`,
    scope: (f) =>
      `\`${f.location}\` (its \`listJobs\` and \`getBoardUrl\`), its fixture tests (\`tests/unit/jobhunt/adapters.test.ts\`, ` +
      `\`tests/unit/jobhunt/adapters-batch2.test.ts\`, \`tests/unit/jobhunt/smartrecruiters-workable.test.ts\`), and how ` +
      `\`sweepBoards\` in \`src/tools/jobhunt/free-ats-source.ts\` hands each payload to the adapter. Nothing outside the ` +
      `jobhunt free lane.`,
    forbidden:
      "Do not make the sweep tolerate an empty result by catching it: a `return []` on a parse error hides the exact " +
      "defect this issue is about. Do not add a network call to a test: the suite runs at $0 and `tests/setup.ts` blocks " +
      "the network, so the fixture must be a saved payload. Do not touch the dead-board skip or its `board-health` " +
      "state (a separate change owns it), and do not edit the thresholds in `src/evolution/analyzers/jobhunt.ts` to make " +
      "this finding go away. If you cannot obtain a current payload (no network in your workspace), say so in the PR and " +
      "stop: a fixture written from memory would make the test pass on a shape the platform does not serve.",
    verify: `pnpm test ${ADAPTER_FIXTURE_TESTS} && pnpm gate`,
    acceptance:
      "A new fixture test in the adapter's test file parses a current, saved payload from the platform (the PR names the " +
      "URL and the date it was fetched) and asserts at least one job with a title and a URL; it fails against the " +
      "unmodified adapter, and the PR body says which payload field the parser read before and which it reads now. " +
      "`pnpm gate` is green.",
  },

  "apply-link-unrecognised": {
    origin: ORIGIN,
    goal: (f) =>
      `Postings on \`${platformOf(f)}\`'s own hosts are being stored with no apply-form link: \`getApplyUrl\` returns null ` +
      `for URLs that ARE on the platform's domain, so \`/draft\` and the Mac client open the posting page instead of the ` +
      `employer's form. Done means every sample URL under Evidence resolves to the platform's form URL, pinned by tests ` +
      `that fail before the fix.`,
    expected:
      "`getApplyUrl(url, company)` in `src/tools/jobhunt/apply-packet.ts` returns the platform's application-form URL for " +
      "each sample URL under Evidence. Postings served from an employer's own domain keep returning null on purpose: " +
      "the form is embedded in their posting page.",
    reproduce: (f) =>
      `You cannot re-run the analyzer, and \`pnpm audit:self\` does not run it. Reproduce it with the URLs under Evidence: ` +
      `call \`getApplyUrl\` on each (a one-line \`tsx\` call, or a failing test case). A null for a URL on ` +
      `${platformOf(f)}'s own host confirms the finding. A non-null result means the recogniser was already fixed: say so ` +
      `and close the issue instead of inventing a change.`,
    scope: (f) =>
      `\`src/tools/jobhunt/board-token.ts\` (\`PATTERNS\`, which decides whether a URL is recognised), the adapter's ` +
      `\`applyUrlFor\` in \`${ADAPTER_SOURCE_PATHS[platformOf(f)] ?? "src/tools/jobhunt/adapters/"}\`, and \`getApplyUrl\` in ` +
      `\`src/tools/jobhunt/apply-packet.ts\`. Background: \`docs/audits/2026-09-28-jobhunt-supply-to-apply-audit.md\`, ` +
      `section 3, which measured the recognisers this finding says have regressed.`,
    forbidden:
      "Do not widen the patterns to match employer-domain URLs: the audit measured 17.8% of postings with no form link BY " +
      "DESIGN (Greenhouse and Recruitee boards on the employer's own domain, where the form is embedded in the posting " +
      "page), and this finding counts only URLs on the platform's own hosts. Do not redefine what the platform's adapter " +
      "treats as its form URL (`applyUrlFor`; SmartRecruiters' form, for one, is the posting page itself): the fix is to " +
      "make the recogniser read these URLs, not to change what a form link is. Do not edit the thresholds in " +
      "`src/evolution/analyzers/jobhunt.ts` to make this finding go away.",
    verify:
      "pnpm test tests/unit/jobhunt/board-token.test.ts tests/unit/jobhunt/apply-url.test.ts && pnpm gate",
    acceptance:
      "Each URL quoted under Evidence is added as a case in `tests/unit/jobhunt/apply-url.test.ts` (or " +
      "`tests/unit/jobhunt/board-token.test.ts` when the change is to recognition) asserting the form URL it must resolve " +
      "to; those cases fail before the fix and pass after. The PR body names the URL shape the recogniser missed. " +
      "`pnpm gate` is green.",
  },
};
