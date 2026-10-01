/**
 * FounderOS — agent brief lint
 * ============================
 * Decides whether an issue body is a brief an unattended executor can act on, before any
 * tokens are spent on it.
 *
 * WHY. Issue #762 ("Jev AI") reached Antigravity naming `src/agents/supervisor.ts` and
 * `src/tools/brain.ts`, files that were never on main (the dispatcher is
 * `src/kernel/supervisor.ts`), and it carried 7 of the template's 9 sections. The executor did
 * what the brief said, wrote a fake integration, and it was reverted in #765. Nothing had
 * looked at the brief first.
 *
 * WHAT IT CHECKS
 *  1. Every `##` heading of .github/ISSUE_TEMPLATE/agent-task.md is present and has content.
 *     A heading holding only whitespace or an HTML comment is the unfilled template, so it
 *     counts as missing.
 *  2. Every path the brief cites exists in the target repository: (a) backticked paths under
 *     src/, scripts/, deploy/ or tests/, anywhere in the brief; (b) path-shaped tokens in the
 *     "Files or subsystem in scope" section even when they are not backticked. Anything under a
 *     heading containing "new file" is exempt: a file the task will create does not exist yet.
 *
 * DOCUMENTED LIMITS. These are deliberate: a lint that guesses blocks the loop on its own false
 * alarms, and a blocked loop is the failure this exists to end.
 *  - Fenced code blocks are never scanned for headings or paths (they do count as content).
 *  - A path outside the scope section that is neither backticked nor under the four roots is
 *    not checked, and neither is a bare root-level file name (`package.json`) in the scope list.
 *  - Globs, `<placeholders>`, `…`, URLs, absolute paths and prose like "read/write" are skipped.
 *  - Only a definite "no" blocks. A lookup that cannot answer (GitHub 5xx, a network error) is
 *    a warning line, never a rejection.
 *  - Paths with spaces are not supported.
 *
 * PURE: no fs, no network, no clock. Existence is asked through the injected `fileExists`;
 * src/tools/dispatch-brief-check.ts wires the real ones (the checkout, or GitHub).
 */

import { checkHeadings, collectPaths, scanLines } from "./agent-brief-parse.js";

// The parsing half owns the template's shape; these are re-exported so callers have one import site.
export {
  AGENT_BRIEF_HEADINGS,
  BRIEF_PATH_ROOTS,
  NEW_FILE_HEADING_TEXT,
  SCOPE_HEADING,
  type AgentBriefHeading,
} from "./agent-brief-parse.js";

/**
 * The longest issue body GitHub accepts. Longer fails with a 422 at issues.create, after the
 * founder has already approved the card, so it is refused up front. It also bounds the work the
 * lint does on model-written text.
 */
export const MAX_BRIEF_CHARS = 65_536;

/** Most existence lookups one lint run may make, so a big brief cannot burn the GitHub rate limit. */
export const MAX_BRIEF_PATH_CHECKS = 30;

/** Lookups in flight at once. */
export const BRIEF_PATH_CHECK_CONCURRENCY = 4;

/** Paths a warning line names before it says "(+N more)". */
const WARNING_NAMES_SHOWN = 5;

/** Longest failure reason quoted in a warning line. */
const WARNING_REASON_MAX = 100;

/** `unknown` means the lookup could not answer (GitHub 5xx, network): a warning, never a rejection. */
export type PathProbe = boolean | "unknown";

/** Asks whether a repo-relative path exists. Throwing or rejecting is the same as `"unknown"`. */
export type FileExists = (path: string) => PathProbe | Promise<PathProbe>;

export interface BriefLintResult {
  readonly ok: boolean;
  /** One legible sentence per problem: missing sections first (template order), then paths. */
  readonly missing: readonly string[];
  /** Template headings that are absent or empty, in template order. */
  readonly missingHeadings: readonly string[];
  /** The subset of `missingHeadings` that is present but holds only whitespace or a comment. */
  readonly emptyHeadings: readonly string[];
  /** Cited paths a lookup definitely reported as not existing, in the order they were cited. */
  readonly missingPaths: readonly string[];
  /** Problems that are neither a section nor a path (today: a body over GitHub's size limit). */
  readonly otherProblems: readonly string[];
  /** Things the lint could not check. They never make `ok` false. */
  readonly warnings: readonly string[];
}

// ── Existence lookups ─────────────────────────────────────────────────────────

function namesWithOverflow(names: readonly string[]): string {
  const shown = names.slice(0, WARNING_NAMES_SHOWN).join(", ");
  const extra = names.length - WARNING_NAMES_SHOWN;
  return extra > 0 ? `${shown} (+${extra} more)` : shown;
}

async function probePaths(
  paths: readonly string[],
  fileExists: FileExists,
): Promise<{ missingPaths: string[]; warnings: string[] }> {
  const checked = paths.slice(0, MAX_BRIEF_PATH_CHECKS);
  const answers: Array<PathProbe | { readonly error: string }> = new Array<PathProbe>(checked.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let i = next++; i < checked.length; i = next++) {
      try {
        answers[i] = await fileExists(checked[i] as string);
      } catch (err) {
        // allow-failopen: a lookup that cannot answer must not block the loop on its own infrastructure; it becomes a warning line.
        answers[i] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BRIEF_PATH_CHECK_CONCURRENCY, checked.length) }, worker));

  const missingPaths: string[] = [];
  const unverified: string[] = [];
  let firstError: string | null = null;
  checked.forEach((path, i) => {
    const answer = answers[i];
    if (answer === false) missingPaths.push(path);
    else if (answer !== true) {
      unverified.push(path);
      if (typeof answer === "object" && firstError === null) firstError = answer.error.slice(0, WARNING_REASON_MAX);
    }
  });

  const warnings: string[] = [];
  if (unverified.length > 0) {
    const noun = checked.length === 1 ? "path" : "paths";
    warnings.push(
      `Could not verify ${unverified.length} of ${checked.length} ${noun} (${firstError ?? "the lookup gave no answer"}); ` +
        `not blocking the dispatch: ${namesWithOverflow(unverified)}.`,
    );
  }
  if (paths.length > checked.length) {
    const skipped = paths.slice(checked.length);
    warnings.push(
      `Only the first ${checked.length} of ${paths.length} paths were checked; ` +
        `${skipped.length} were not checked: ${namesWithOverflow(skipped)}.`,
    );
  }
  return { missingPaths, warnings };
}

// ── Public API ────────────────────────────────────────────────────────────────

function headingSentence(heading: string, isEmpty: boolean): string {
  return isEmpty
    ? `Section "## ${heading}" is empty (only whitespace or an HTML comment).`
    : `Section "## ${heading}" is missing.`;
}

/**
 * Lints a brief. Pure apart from `fileExists`, which the caller injects.
 *
 * Reports everything at once (sections and paths together) so the author fixes the brief in one
 * round trip instead of one problem at a time.
 */
export async function lintAgentBrief(body: string, fileExists: FileExists): Promise<BriefLintResult> {
  if (body.length > MAX_BRIEF_CHARS) {
    const problem =
      `The brief is ${body.length.toLocaleString("en-US")} characters; GitHub rejects an issue body over ` +
      `${MAX_BRIEF_CHARS.toLocaleString("en-US")}. Shorten it: keep what an executor with no context needs.`;
    return { ok: false, missing: [problem], missingHeadings: [], emptyHeadings: [], missingPaths: [], otherProblems: [problem], warnings: [] };
  }
  const lines = scanLines(body);
  const headings = checkHeadings(lines);
  const paths = await probePaths(collectPaths(lines), fileExists);

  const missing = [
    ...headings.missing.map((heading) => headingSentence(heading, headings.empty.includes(heading))),
    ...paths.missingPaths.map((path) => `\`${path}\` does not exist in the repository.`),
  ];
  return {
    ok: missing.length === 0,
    missing,
    missingHeadings: headings.missing,
    emptyHeadings: headings.empty,
    missingPaths: paths.missingPaths,
    otherProblems: [],
    warnings: paths.warnings,
  };
}

export interface BriefRejectionOptions {
  /** `owner/repo` the brief would have been filed on. */
  readonly target: string;
  /** Text appended to a section's problem line, keyed by template heading: which input fills it. */
  readonly hints?: Readonly<Record<string, string>>;
  /** Appended to the paragraph explaining where files-to-be-created go: how to do it here. */
  readonly newFilesHint?: string;
}

/** The rejection the model (and through it the founder) reads: every problem with its own reason. */
export function formatBriefRejection(result: BriefLintResult, opts: BriefRejectionOptions): string {
  const problems = [
    ...result.missingHeadings.map((heading) => {
      const sentence = headingSentence(heading, result.emptyHeadings.includes(heading));
      const hint = opts.hints?.[heading];
      return hint ? `${sentence} ${hint}` : sentence;
    }),
    ...result.missingPaths.map((path) => `\`${path}\` does not exist in ${opts.target}.`),
    ...result.otherProblems,
  ];

  // Advice only for the problems it applies to: a size problem needs neither paragraph.
  const advice: string[] = [];
  if (result.missingPaths.length > 0) {
    advice.push(
      'Name only files that exist today. A file this task will CREATE is not an error: list it under a heading that contains "new file" ' +
        '(for example "### New files to create") and it is not checked.' +
        (opts.newFilesHint ? ` ${opts.newFilesHint}` : ""),
    );
  }
  if (result.missingHeadings.length > 0 || result.missingPaths.length > 0) {
    advice.push("If you do not know something, ask the founder. Never guess, and never leave a placeholder.");
  }

  const lines = [
    `Brief rejected: nothing was filed on ${opts.target}. ` +
      `${problems.length} ${problems.length === 1 ? "problem" : "problems"} to fix:`,
    ...problems.map((problem, i) => `${i + 1}. ${problem}`),
    ...(advice.length > 0 ? ["", ...advice] : []),
  ];
  if (result.warnings.length > 0) lines.push("", ...result.warnings.map((warning) => `Note: ${warning}`));
  return lines.join("\n");
}
