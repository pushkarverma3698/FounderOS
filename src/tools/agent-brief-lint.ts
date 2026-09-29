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

import { posix } from "node:path";

/**
 * The `##` headings of .github/ISSUE_TEMPLATE/agent-task.md, in template order. The dispatcher's
 * claim-time check (AGENT_BRIEF_HEADINGS in deploy/agent-dispatch) must list the same nine; a
 * test compares this list to the template so the two cannot drift apart.
 */
export const AGENT_BRIEF_HEADINGS = [
  "Goal",
  "Problem / observed behavior",
  "Expected behavior",
  "Evidence",
  "Files or subsystem in scope",
  "Constraints",
  "Explicitly forbidden",
  "Verification commands",
  "Acceptance criteria",
] as const;

export type AgentBriefHeading = (typeof AGENT_BRIEF_HEADINGS)[number];

/** The section whose plain-text paths are checked even without backticks. */
export const SCOPE_HEADING: AgentBriefHeading = "Files or subsystem in scope";

/** Roots under which a backticked path is checked anywhere in a brief. */
export const BRIEF_PATH_ROOTS = ["src", "scripts", "deploy", "tests"] as const;

/** A heading containing this text (any case) exempts everything under it from the path check. */
export const NEW_FILE_HEADING_TEXT = "new file";

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
  /** Things the lint could not check. They never make `ok` false. */
  readonly warnings: readonly string[];
}

// ── Markdown structure ────────────────────────────────────────────────────────

interface BriefLine {
  /** The line with HTML comments removed. Empty inside a fence. */
  readonly text: string;
  readonly fenced: boolean;
  /** Non-blank code inside a fence: content for the emptiness check, never scanned. */
  readonly fenceContent: boolean;
}

const BACKTICK_FENCE = /^ {0,3}(`{3,})([^`]*)$/;
const TILDE_FENCE = /^ {0,3}(~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/;

/** Splits a body into lines, removing HTML comments and marking fenced code. */
function scanLines(body: string): BriefLine[] {
  const out: BriefLine[] = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  let inComment = false;

  for (const raw of body.split(/\r?\n/)) {
    if (fence) {
      const close = (fence.char === "`" ? BACKTICK_FENCE : TILDE_FENCE).exec(raw);
      const closes = close?.[1] !== undefined && close[1].length >= fence.length && raw.trim() === close[1];
      if (closes) fence = null;
      out.push({ text: "", fenced: true, fenceContent: !closes && raw.trim() !== "" });
      continue;
    }

    let text = "";
    let rest = raw;
    while (rest !== "") {
      if (inComment) {
        const end = rest.indexOf("-->");
        inComment = end < 0;
        rest = end < 0 ? "" : rest.slice(end + 3);
      } else {
        const start = rest.indexOf("<!--");
        text += start < 0 ? rest : rest.slice(0, start);
        inComment = start >= 0;
        rest = start < 0 ? "" : rest.slice(start + 4);
      }
    }

    const open = BACKTICK_FENCE.exec(text) ?? TILDE_FENCE.exec(text);
    if (open?.[1]) {
      fence = { char: open[1].charAt(0), length: open[1].length };
      out.push({ text: "", fenced: true, fenceContent: false });
      continue;
    }
    out.push({ text, fenced: false, fenceContent: false });
  }
  return out;
}

interface Heading {
  readonly level: number;
  readonly title: string;
}

function headingOf(text: string): Heading | null {
  const match = ATX_HEADING.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const title = match[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
  return title === "" ? null : { level: match[1].length, title };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").replace(/[:\s]+$/, "").trim();
}

// ── Template sections ─────────────────────────────────────────────────────────

/** Which level-2 sections exist, and whether any occurrence of each has content. */
function sectionContent(lines: readonly BriefLine[]): Map<string, boolean> {
  const sections = new Map<string, boolean>();
  let current: string | null = null;

  for (const line of lines) {
    if (!line.fenced) {
      const heading = headingOf(line.text);
      if (heading) {
        if (heading.level <= 2) current = null;
        if (heading.level === 2) {
          current = normalizeTitle(heading.title);
          if (!sections.has(current)) sections.set(current, false);
        }
        continue;
      }
    }
    const hasContent = line.fenced ? line.fenceContent : line.text.trim() !== "";
    if (current !== null && hasContent) sections.set(current, true);
  }
  return sections;
}

function checkHeadings(lines: readonly BriefLine[]): { missing: string[]; empty: string[] } {
  const sections = sectionContent(lines);
  const missing: string[] = [];
  const empty: string[] = [];
  for (const heading of AGENT_BRIEF_HEADINGS) {
    const filled = sections.get(normalizeTitle(heading));
    if (filled === true) continue;
    missing.push(heading);
    if (filled === false) empty.push(heading);
  }
  return { missing, empty };
}

// ── Cited paths ───────────────────────────────────────────────────────────────

/** Characters a checkable path may contain. Anything else (`*`, `<`, `{`, `…`, `:`) is not a path. */
const PATH_CHARS = /^[A-Za-z0-9._@+/-]+$/;
const LINE_REFERENCE = /(?::L?\d+(?:[:-]L?\d+)*|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;
/** A name that is a file, not a directory: it cannot be followed by a child segment. */
const FILE_NAME = /\.(?:[cm]?[jt]sx?|json|mdx?|sh|ya?ml|py|sql|s?css|html|txt|toml|env|lock)$/i;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const LEADING_EDGE = /^[([{"']+/;
const TRAILING_EDGE = /[)\]}"'.,;:!?]+$/;

function stripEdges(token: string): string {
  return token.replace(LEADING_EDGE, "").replace(TRAILING_EDGE, "");
}

/**
 * A repo-relative path from one token, or null when the token is not a checkable path.
 *
 * `scope` tokens come from plain text in the scope section, so they must look like a path on
 * their own (a slash, plus a file extension, a trailing slash or a known root). Backticked
 * tokens are already deliberate, so they only have to sit under one of the four roots.
 */
function toRepoPath(raw: string, scope: boolean): string | null {
  let token = raw.trim();
  const emphasis = /^(\*{1,3})([^*]+)\1$/.exec(token);
  if (emphasis?.[2]) token = emphasis[2];
  if (token.includes("*")) return null;

  token = stripEdges(stripEdges(token).replace(LINE_REFERENCE, ""));
  if (token === "" || !PATH_CHARS.test(token)) return null;

  const isDirectory = token.endsWith("/");
  const normalized = posix.normalize(token);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return null;

  const path = normalized.replace(/\/+$/, "");
  const segments = path.split("/");
  const first = segments[0] ?? "";
  if (path === "" || path === "." || first === "") return null;
  if (segments.length < 2 && !isDirectory) return null;
  if (first.startsWith("@")) return null;
  if (first.includes(".") && !first.startsWith(".")) return null;
  if (segments.slice(0, -1).some((segment) => FILE_NAME.test(segment))) return null;

  const underRoot = (BRIEF_PATH_ROOTS as readonly string[]).includes(first);
  if (!scope) return underRoot ? path : null;
  return underRoot || isDirectory || HAS_EXTENSION.test(segments[segments.length - 1] ?? "") ? path : null;
}

/** Tokens of a scope-section line. Placeholders become a marker no path can contain. */
function scopeTokens(text: string): string[] {
  return text
    .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, " $1 $2 ")
    .replace(/<[^<>]*>/g, "￿")
    .replace(/`/g, " ")
    .split(/[\s,;]+/)
    .filter((token) => token !== "");
}

/** Backticked spans that are a single token: a command like `pnpm test x` is not a path. */
function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((span) => span !== "" && !/\s/.test(span));
}

/** Every path the brief cites that must exist, scope section first, each once. */
function collectPaths(lines: readonly BriefLine[]): string[] {
  const scopeKey = normalizeTitle(SCOPE_HEADING);
  const stack: Heading[] = [];
  const inScope: string[] = [];
  const backticked: string[] = [];

  for (const line of lines) {
    if (line.fenced) continue;
    const heading = headingOf(line.text);
    if (heading) {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop();
      stack.push(heading);
      continue;
    }
    if (stack.some((h) => h.title.toLowerCase().includes(NEW_FILE_HEADING_TEXT))) continue;

    for (const token of backtickedTokens(line.text)) {
      const path = toRepoPath(token, false);
      if (path) backticked.push(path);
    }
    if (stack.some((h) => h.level === 2 && normalizeTitle(h.title) === scopeKey)) {
      for (const token of scopeTokens(line.text)) {
        const path = toRepoPath(token, true);
        if (path) inScope.push(path);
      }
    }
  }
  return [...new Set([...inScope, ...backticked])];
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
  ];

  const lines = [
    `Brief rejected: nothing was filed on ${opts.target}. ` +
      `${problems.length} ${problems.length === 1 ? "problem" : "problems"} to fix:`,
    ...problems.map((problem, i) => `${i + 1}. ${problem}`),
    "",
    'Name only files that exist today. A file this task will CREATE is not an error: list it under a heading that contains "new file" ' +
      '(for example "### New files to create") and it is not checked.' +
      (opts.newFilesHint ? ` ${opts.newFilesHint}` : ""),
    "If you do not know something, ask the founder. Never guess, and never leave a placeholder.",
  ];
  if (result.warnings.length > 0) lines.push("", ...result.warnings.map((warning) => `Note: ${warning}`));
  return lines.join("\n");
}
