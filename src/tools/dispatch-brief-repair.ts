/**
 * FounderOS — a brief that cites a file that is not there is repaired, not refused
 * ================================================================================
 * THE DEAD END THIS REMOVES. Since the brief lint went in (2026-09-29, ./agent-brief-lint.ts) every
 * plain-English `/task` has had to survive one rule: every path the brief cites must exist today. The model
 * that writes the brief is a cheap planner that has never seen the repository, so for an Oplify repo, or for
 * "the pr-brain script", it invents the path. On 2026-10-02 four natural-language requests in a row died there:
 * `src/agent/pr-brain.ts`, `src/agent/antigravity-runner.ts`, `scripts/pr-brain.ts` (the real file is
 * `deploy/vps-daemons/pr-brain`). The tool refused, the model called one read-only tool and gave up, and the
 * founder got "could not be dispatched" under a "✓ 1 action completed and verified". The only /task requests
 * that went through were ones where he typed the exact paths himself, which is the one thing a founder at a
 * phone cannot be asked to do.
 *
 * WHY REFUSING WAS THE WRONG SHAPE. The lint exists because #762 shipped a fake integration from a brief that
 * named files that were never there: the executor believed the paths. The defect is a path presented as FACT.
 * Antigravity reads the whole repository; it is the one party that can find the right file. So a cited path that
 * does not exist is not rejected: it is demoted to an explicit, labelled hint (inside a code fence, which the lint
 * documents as unscanned), with an instruction to locate the real code first and to stop and ask on the issue
 * rather than invent a location. A path that DOES exist stays in scope as a fact, verified. The founder sees the
 * demotion on the approval card ("Not verified: …"), so nothing is filed that he was not told about.
 *
 * WHAT IS STILL REFUSED. Everything the lint refuses that is not a missing path: an empty section, an oversized
 * body. Those need information the tool does not have, and the rejection says exactly what.
 *
 * EVIDENCE. A founder who asks for a feature has no log line to attach, and "never invent evidence" used to make
 * that request unfileable. His own words ARE evidence of what was asked for: `founder_request`, copied verbatim
 * by the planner (it is an exact copy, not a paraphrase), is filed as the Evidence section when nothing better
 * was given, with a plain statement that nothing else was provided.
 *
 * PURE. No fs, no network: the lint and the formatter are injected.
 */

import type { AntigravityTaskInput } from "./dispatch-antigravity.js";
import type { BriefLintResult } from "./agent-brief-lint.js";

/** Longest path demoted into a hint. A degenerate "path" is not worth quoting back. */
const MAX_HINT_CHARS = 200;

const WORD_CHARS = "A-Za-z0-9_@+/\\-";
/** A line reference the lint strips before it checks a path: `:12`, `:12-20`, `#L12`, `#L12C3-L20`. */
const LINE_REF = "(?::L?\\d+(?:[:-]L?\\d+)*|#L\\d+(?:C\\d+)?(?:-L?\\d+(?:C\\d+)?)?)?";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The path as a token: not glued to a longer path, tolerant of a `./` prefix, a line reference and a trailing dot. */
function tokenPattern(path: string): string {
  return `(?<![${WORD_CHARS}.])(?:\\./)?${escapeRegExp(path)}${LINE_REF}(?!\\.?[${WORD_CHARS}])`;
}

/** Fields a brief cites paths in, besides the scope (which is handled on its own: plain tokens count there). */
const OTHER_TEXT_FIELDS = ["goal", "expected", "problem", "evidence", "verification", "acceptance", "forbidden", "constraints"] as const;

export interface RepairedBrief {
  readonly input: AntigravityTaskInput;
  /** The paths that were demoted, in the order the lint reported them. */
  readonly demoted: readonly string[];
}

/** The explanation that heads the hints. Contains no path-like token: plain text in the scope section is scanned. */
const HINT_HEADING =
  "Paths the author cited that do NOT exist in this repository (checked when the brief was filed). They are guesses, " +
  "not facts. Locate the real code first: list the directories, grep for the names. Create nothing at these paths " +
  'unless the "New files" list names them. If you cannot find where this belongs, stop and say so on the issue ' +
  "instead of inventing a location.";

/**
 * Demotes `missingPaths` (as the lint reported them) out of the brief's facts and into labelled hints.
 *  - in the scope: each occurrence becomes `[unverified path N]` and the paths are listed in a fenced block;
 *  - everywhere else: a backticked path loses its backticks (the only form the lint checks outside the scope) and
 *    is followed by "(unverified)", so prose such as "fix `src/x.ts`" does not read as a verified fact.
 */
export function demoteMissingPaths(input: AntigravityTaskInput, missingPaths: readonly string[]): RepairedBrief {
  const demoted = missingPaths.filter((p) => p.length > 0 && p.length <= MAX_HINT_CHARS);
  if (demoted.length === 0) return { input, demoted: [] };

  let scope = input.scope;
  demoted.forEach((path, i) => {
    scope = scope.replace(new RegExp(tokenPattern(path), "g"), `[unverified path ${i + 1}]`);
  });
  // A backticked occurrence in the scope leaves empty backticks behind: `[unverified path 1]` stays quoted, which is fine.

  const repaired: Record<string, unknown> = { ...input };
  for (const field of OTHER_TEXT_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value === "") continue;
    let text = value;
    for (const path of demoted) {
      // `src/x.ts` and `src/x.ts:12` -> src/x.ts (unverified): the lint reads backticked tokens only.
      text = text.replace(new RegExp(`\`\\s*(${tokenPattern(path)})\\s*\``, "g"), "$1 (unverified)");
    }
    repaired[field] = text;
  }

  const listed = demoted.map((path, i) => `${i + 1}. ${path}`).join("\n");
  repaired["scope"] = `${scope.trim()}\n\n${HINT_HEADING}\n\n\`\`\`text\n${listed}\n\`\`\``;
  return { input: repaired as unknown as AntigravityTaskInput, demoted };
}

/** The founder's own words as the Evidence section, with a plain statement that nothing else came with them. */
export function evidenceFromFounderRequest(request: string): string {
  const quoted = request
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return (
    `The founder's request, verbatim:\n\n${quoted}\n\n` +
    "Nothing else came with it: no log line, error text or reference. Antigravity establishes the current behavior " +
    "itself, by reading the code and running it, and records what it found in the PR description."
  );
}

/** Fills an empty Evidence section from the founder's request; leaves anything the caller supplied alone. */
export function withFounderRequestEvidence(input: AntigravityTaskInput, founderRequest: string | undefined | null): AntigravityTaskInput {
  const request = founderRequest?.trim();
  if (!request || input.evidence?.trim()) return input;
  return { ...input, evidence: evidenceFromFounderRequest(request) };
}

/**
 * Fills an empty Problem section from the founder's request. The planner omitted `problem` on most first calls
 * (2026-10-03, ~5 of 8): the lint rejected the brief and a model turn went on re-calling. What the founder asked for
 * is what he described, so his words are the Problem, labelled as such; anything the caller supplied is kept.
 */
export function withFounderRequestProblem(input: AntigravityTaskInput, founderRequest: string | undefined | null): AntigravityTaskInput {
  const request = founderRequest?.trim();
  if (!request || input.problem?.trim()) return input;
  const quoted = request
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return { ...input, problem: `The founder described it as:\n\n${quoted}` };
}

/** The sections {@link withFounderRequestBrief} can fill, as the founder reads them on the approval card. */
export type FilledSection = "Goal" | "Expected" | "Verification";

/** Verification when the planner gave none: the repo's own checks, no command invented for a repo nobody here has seen. No backticks: the lint reads a backticked token as a path. */
export const VERIFICATION_REPO_CHECKS =
  "Run the repository's own checks, the ones its CLAUDE.md, AGENTS.md, package.json scripts or CI workflow name " +
  "(tests, lint, type check, build), and paste their raw output into the PR description. Then exercise the changed " +
  "behavior once through its real entry point and paste that output too. Anything you could not run goes under " +
  "NOT VERIFIED, with the reason.";

const isBlank = (value: string | undefined | null): boolean => !value || value.trim() === "";

const quoteLines = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

/**
 * C-P0-2: `/task` writes the brief. A founder at a phone sends one sentence, and the cheap planner that expands it
 * sometimes omits Goal, Expected or Verification; the tool used to bounce on that before any approval card existed.
 * His own words are what was asked for, so a blank section is filled from them, quoted and labelled, and the card
 * says which sections were filled. Verification is the repository's own checks, never a command guessed for it.
 * Anything the planner DID supply is kept. Without a founder request nothing is invented: the blank stays blank and
 * the caller refuses.
 */
export function withFounderRequestBrief(
  input: AntigravityTaskInput,
  founderRequest: string | undefined | null,
): { readonly input: AntigravityTaskInput; readonly filled: readonly FilledSection[] } {
  const request = founderRequest?.trim();
  const filled: FilledSection[] = [];
  if (!request) return { input, filled };

  const quoted = quoteLines(request);
  const next = { ...input };
  if (isBlank(input.goal)) {
    next.goal = `Do what the founder asked, in his words:\n\n${quoted}\n\nDone means the request is satisfied as worded, by the smallest change that does it, with the repository's checks passing.`;
    filled.push("Goal");
  }
  if (isBlank(input.expected)) {
    next.expected =
      `The behavior the founder asked for, in his words:\n\n${quoted}\n\n` +
      "The request is short. Where it leaves a detail open, choose the smallest change that satisfies it and state each choice in the PR description.";
    filled.push("Expected");
  }
  if (isBlank(input.verification)) {
    next.verification = VERIFICATION_REPO_CHECKS;
    filled.push("Verification");
  }
  return filled.length === 0 ? { input, filled } : { input: next, filled };
}

/**
 * What an empty scope is filed as. The first line is the label the founder sees on the card ("Files: paths: agent to
 * locate"). No path-like token: plain text in the scope section is scanned by the lint.
 */
export const SCOPE_UNKNOWN =
  "paths: agent to locate\n\n" +
  "The request named no files. Locate the code this touches first: list the directories, grep for the names. " +
  "Record what you found in the PR description. If you cannot tell where this belongs, stop and say so on the " +
  "issue instead of inventing a location.";

/** The card's Files line when the scope was left blank (the card shows the model's own input, not the repaired one). */
export const SCOPE_UNKNOWN_LABEL = "paths: agent to locate";

const SCOPE_UNKNOWN_WARNING =
  "No file paths were given, so the scope is filed as 'paths: agent to locate'. Antigravity finds the files itself.";

/** True when a scope says nothing: absent, whitespace, or only an HTML comment (the template's placeholder). */
export function isBlankScope(scope: string | undefined | null): boolean {
  return !scope || scope.replace(/<!--[\s\S]*?-->/g, "").trim() === "";
}

export type PreparedBrief =
  | {
      readonly ok: true;
      readonly input: AntigravityTaskInput;
      readonly body: string;
      readonly lint: BriefLintResult;
      /** Paths that were not found and were filed as unverified hints. Empty for a brief that needed no repair. */
      readonly demoted: readonly string[];
      /** Sections filled from the founder's own sentence because the planner left them blank (the card names them). */
      readonly filled: readonly FilledSection[];
      /** What the founder is told on the approval card and in the reply: lint warnings plus the demotion. */
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly input: AntigravityTaskInput;
      readonly body: string;
      readonly lint: BriefLintResult;
    };

export interface PrepareDeps {
  /** The brief lint against the repo it would be filed on (src/tools/dispatch-antigravity.ts lintDispatchBrief). */
  readonly lint: (body: string) => Promise<BriefLintResult>;
  /** The issue body for an input (formatAntigravityIssueBody). */
  readonly format: (input: AntigravityTaskInput) => string;
}

/**
 * The one path from what the model passed to what is previewed and filed. Called above the approval gate and again
 * inside execute(): it is deterministic for the same input and repository state, so both see the same body.
 *
 * Lint once; if the only fault is paths that do not exist, demote them and lint the repaired brief. A repair that
 * does not pass (a form of path the demotion does not recognise) falls back to the lint's own rejection: no worse
 * than before this existed.
 */
export async function prepareDispatchBrief(
  input: AntigravityTaskInput,
  founderRequest: string | undefined | null,
  deps: PrepareDeps,
): Promise<PreparedBrief> {
  const scopeUnknown = isBlankScope(input.scope);
  const withScope = scopeUnknown ? { ...input, scope: SCOPE_UNKNOWN } : input;
  const { input: withSections, filled } = withFounderRequestBrief(withScope, founderRequest);
  const withEvidence = withFounderRequestEvidence(withFounderRequestProblem(withSections, founderRequest), founderRequest);
  const prepared = await prepare(withEvidence, deps.format(withEvidence), deps);
  if (!prepared.ok) return prepared;
  // First, so it is the line the approval card quotes: it is the one thing the founder has not seen in the brief.
  return { ...prepared, filled, warnings: scopeUnknown ? [SCOPE_UNKNOWN_WARNING, ...prepared.warnings] : prepared.warnings };
}

async function prepare(withEvidence: AntigravityTaskInput, body: string, deps: PrepareDeps): Promise<PreparedBrief> {
  const lint = await deps.lint(body);
  if (lint.ok) return { ok: true, input: withEvidence, body, lint, demoted: [], filled: [], warnings: lint.warnings };

  if (lint.missingPaths.length === 0) return { ok: false, input: withEvidence, body, lint };

  const { input: repaired, demoted } = demoteMissingPaths(withEvidence, lint.missingPaths);
  const repairedBody = deps.format(repaired);
  const repairedLint = await deps.lint(repairedBody);
  if (!repairedLint.ok) return { ok: false, input: repaired, body: repairedBody, lint: repairedLint };

  const shown = demoted.slice(0, 5).join(", ") + (demoted.length > 5 ? ` (+${demoted.length - 5} more)` : "");
  return {
    ok: true,
    input: repaired,
    body: repairedBody,
    lint: repairedLint,
    demoted,
    filled: [],
    warnings: [
      `Not found in the repository, so filed as unverified hints, not facts: ${shown}. Antigravity locates the real files itself.`,
      ...repairedLint.warnings,
    ],
  };
}
