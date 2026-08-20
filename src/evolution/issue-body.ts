/**
 * Evolution Engine — render a Finding as a dispatchable GitHub issue.
 * ====================================================================
 * Task 6 of docs/plans/2026-08-12-self-improvement-audit.md, built the way the
 * founder redirected it on 2026-08-13: the acting loop files an ISSUE for the
 * existing `agent-dispatch` pipeline instead of running Claude Code with
 * `acceptEdits` against the live tree.
 *
 * That redirect was not a preference. The old acting loop could not execute at
 * all — `runSelfImprovementLoop` passed `cwd: process.cwd()` into
 * `claudeCodeTool`, and `resolveExecutorCwd` (src/tools/claude-code.ts) refuses
 * both hosts: the laptop because the path IS the FounderOS repo, prod because
 * `/opt/founderos` is outside `~/Projects`. Scheduling it would have produced a
 * "🛠 Initiated" message followed by "⚠️ Access denied", every three days,
 * forever. Routing through issues also moves the gate from "none" to "draft PR
 * reviewed by pr-brain before a human merges" — which is what Task 6 asked for.
 *
 * This module is PURE. Rendering an issue must be testable without a network,
 * a token, or a repository, because the thing that makes an unattended issue
 * useful is entirely in its text: Antigravity reads it with no conversation
 * history and no idea why it was filed (docs/antigravity/ISSUE-DRIVEN-CONTRACT.md).
 */

import { computeFingerprint } from "./fingerprint.js";
import type { Finding, FindingKind } from "./types.js";

/**
 * Machine-readable identity embedded in every issue this loop files, so a
 * finding that persists across audits does not spawn a fresh issue every three
 * days. The fingerprint is the same one `evolution_findings` keys on
 * (src/evolution/fingerprint.ts), so an issue and its DB row agree on what
 * "the same defect" means.
 */
export const FINDING_MARKER_PREFIX = "<!-- evolution-finding:";

/** Label carried by every auto-filed issue — the scan for prior filings reads exactly this set. */
export const EVOLUTION_LABEL = "evolution:auto";

/** The intake gate `agent-dispatch` claims on. Applying it starts an unattended implementation. */
export const AGENT_READY_LABEL = "agent:ready";

/** GitHub issue titles are truncated in every list view; keep the subject readable in one line. */
const MAX_SUBJECT_IN_TITLE = 80;

export function findingMarker(fingerprint: string): string {
  return `${FINDING_MARKER_PREFIX} ${fingerprint} -->`;
}

interface KindGuidance {
  /** What "done" means, in one paragraph, to a reader with no context. */
  readonly goal: string;
  /** What should happen instead of the observed behavior. */
  readonly expected: string;
  /** Where to look. Never "somewhere in src/" — the contract rejects that. */
  readonly scope: string;
  /** Task-specific prohibitions only; the general rules live in STANDARDS.md. */
  readonly forbidden: string;
  /** The exact command whose raw output proves the fix. */
  readonly verify: string;
  /** What pr-brain checks before this counts as PASS. */
  readonly acceptance: string;
}

/**
 * The kinds an unattended executor can close correctly, and what it should do
 * for each.
 *
 * A kind is absent from this map when acting on it needs a decision rather than
 * an implementation. Those findings still reach the founder — the 3-day audit
 * report (Loop A) lists every kind — they are simply never turned into an
 * unattended PR. Dropping a finding from the REPORT would be the mistake
 * CLAUDE.md warns about; declining to hand it to a robot is not.
 *
 * Deliberately excluded, with the reason:
 *   · cost-hotspot   — "gemini-flash-latest is 73% of spend" has no code fix.
 *                      It is a model-policy call for the founder; an executor
 *                      handed this would invent a refactor to look productive.
 *   · orphan-module  — deleting a subsystem needs judgement about whether it is
 *                      dead or merely not wired up YET. On 2026-08-06 an
 *                      approved "fix" of exactly this shape would have erased a
 *                      deliberate distinction in findOrphanSubsystems.
 *   · dead-export    — 156 open findings at the time of writing. Mass unattended
 *                      deletion is the largest blast radius the analyzers can
 *                      produce, for the smallest gain available.
 *   · oversized-prompt — trimming a prompt changes model behavior, which is a
 *                      product decision measured by eval, not a code fix.
 *   · loc-pressure   — splitting a file near the 400-line budget is a refactor
 *                      whose boundaries are a design choice.
 */
const GUIDANCE: Partial<Record<FindingKind, KindGuidance>> = {
  "unapplied-lesson": {
    goal:
      "A failure lesson with a known, proven fix is never being injected into the retry that would use it. " +
      "Done means the stored lesson reaches the retry path, proven by a test that fails without the fix.",
    expected:
      "When a worker fails with a signature that has a resolved lesson, the retry receives that lesson. " +
      "`times_applied` for the row then rises on a real retry rather than staying at 0 forever.",
    scope:
      "`src/kernel/lessons.ts` (signature normalisation and lesson lookup), `getFailureLesson` in " +
      "`src/db/queries.ts`, and the worker retry path in `src/kernel/worker.ts`.",
    forbidden:
      "Do not change the lesson-eligibility rule (`times_resolved > 0`) in `getFailureLesson`. " +
      "Occurrence-only rows have no fix to inject and excluding them is deliberate — see the comment on " +
      "`findUnappliedLessons` in `src/evolution/analyzers/telemetry.ts`.",
    verify: "pnpm test tests/unit/kernel/lessons.test.ts && pnpm gate",
    acceptance:
      "A new unit test asserts that a failure whose signature has a resolved lesson produces a retry " +
      "carrying that lesson, and that test fails when the fix is reverted.",
  },
  "recurring-failure": {
    goal:
      "One component is failing under several distinct error signatures, which usually means one shared root " +
      "cause rather than several unrelated bugs. Done means the shared cause is found and fixed, or — if the " +
      "signatures are genuinely unrelated — that is stated with evidence and the smallest one is fixed.",
    expected:
      "The component handles the inputs that currently produce these signatures, or fails with a single typed, " +
      "actionable FailureReport instead of several ad-hoc ones.",
    scope:
      "Start from the component named in the title. Read the `failure_lessons` rows for it " +
      "(`select signature, times_seen from failure_lessons where component = '<subject>'`) before changing code.",
    forbidden:
      "Do not make the failures disappear by widening a catch or lowering a threshold. A silent pass is a worse " +
      "outcome than the current loud failure.",
    verify: "pnpm gate",
    acceptance:
      "A regression test reproduces at least one of the named signatures and fails without the fix. The PR body " +
      "states which signatures the fix covers and which it does not.",
  },
  "unused-dependency": {
    goal:
      "A package is declared in `package.json` but imported nowhere in `src/`. Done means it is removed and the " +
      "build, types and full test suite still pass.",
    expected: "`package.json` no longer declares the package, and `pnpm gate` is green.",
    scope: "`package.json` and `pnpm-lock.yaml` only.",
    forbidden:
      "Do not remove anything still referenced from `scripts/`, `tests/`, a config file " +
      "(eslint/vitest/tsconfig/drizzle), or a `postinstall`. The analyzer only reads `src/`, so confirm the " +
      "wider tree with `grep -rn \"<package>\" --exclude-dir=node_modules .` before deleting. Also check " +
      "`pnpm why <package>`: a package no source file imports may still be a peer or runtime dependency " +
      "another package needs (`@langchain/langgraph-checkpoint` is required by `@langchain/langgraph`, for " +
      "example). If it IS needed, close the issue saying so — that is the correct outcome, not a failure.",
    verify: "pnpm gate",
    acceptance:
      "`pnpm gate` passes with the dependency removed, and the PR body shows the grep proving nothing outside " +
      "`src/` referenced it.",
  },
  "untested-module": {
    goal:
      "A source module has no corresponding test file. Done means it has real unit tests covering its exported " +
      "behavior — not a smoke test that imports the module and asserts it is defined.",
    expected:
      "A test file exists under `tests/unit/` mirroring the module's path, and it fails if the module's logic is " +
      "broken.",
    scope:
      "Add `tests/unit/<mirrored path>.test.ts`. The module under test is named in the title and should not need " +
      "to change.",
    forbidden:
      "Do not modify the module under test to make it easier to test unless that change is itself justified in " +
      "the PR body. Do not write tests that assert an implementation detail (a private call order, an internal " +
      "field) — assert observable behavior. Do not make any live API call; the suite runs at $0.",
    verify: "pnpm test <the new test file> && pnpm gate",
    acceptance:
      "The new tests fail when a deliberate bug is introduced into the module (state in the PR body which " +
      "mutation you tried and that it failed), and `pnpm gate` is green.",
  },
};

/** Kinds this loop is willing to hand to an unattended executor, in no particular order. */
export const DISPATCHABLE_KINDS: readonly FindingKind[] = Object.keys(GUIDANCE) as FindingKind[];

/** True when a finding is one an unattended executor can close without making a product decision. */
export function isDispatchable(finding: Finding): boolean {
  return GUIDANCE[finding.kind] !== undefined;
}

/**
 * The first finding in an already-ranked list that is dispatchable and has not
 * been filed before. `alreadyFiled` holds fingerprints this loop has previously
 * turned into issues — see `dispatch-findings.ts` for how that set is read back
 * from GitHub.
 */
export function pickDispatchTarget(
  ranked: readonly Finding[],
  alreadyFiled: ReadonlySet<string>,
): { readonly finding: Finding; readonly fingerprint: string } | null {
  for (const finding of ranked) {
    if (!isDispatchable(finding)) continue;
    const fingerprint = computeFingerprint(finding);
    if (alreadyFiled.has(fingerprint)) continue;
    return { finding, fingerprint };
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function renderIssueTitle(finding: Finding): string {
  return `[self-audit] ${finding.kind}: ${truncate(finding.subject, MAX_SUBJECT_IN_TITLE)}`;
}

/**
 * The issue body, in the exact section order of
 * `.github/ISSUE_TEMPLATE/agent-task.md`. Every section is filled: the template
 * says `agent:ready` must not be applied until they are, and this loop applies
 * that label itself.
 */
export function renderIssueBody(
  finding: Finding,
  context: { readonly fingerprint: string; readonly commitSha?: string | null; readonly detectedAt: Date },
): string {
  const guidance = GUIDANCE[finding.kind];
  if (!guidance) {
    throw new Error(
      `Refusing to render an issue for finding kind "${finding.kind}" — it is not in DISPATCHABLE_KINDS. ` +
        `Acting on it needs a decision, not an implementation (see src/evolution/issue-body.ts).`,
    );
  }

  const location = finding.location ? `\n- Location: \`${finding.location}\`` : "";
  const commit = context.commitSha ? `\n- Detected at commit: \`${context.commitSha}\`` : "";

  return [
    findingMarker(context.fingerprint),
    "",
    "> Filed automatically by the FounderOS self-audit acting loop " +
      "(`src/evolution/dispatch-findings.ts`). Nobody wrote this by hand — the finding below came from a " +
      "static/telemetry analyzer run, and the numbers in it are reproducible with the verification command.",
    "",
    "## Goal",
    "",
    guidance.goal,
    "",
    "## Problem / observed behavior",
    "",
    `The \`${finding.kind}\` analyzer reported **${finding.subject}** at ${finding.severity} severity:`,
    "",
    `> ${finding.evidence}`,
    "",
    "## Expected behavior",
    "",
    guidance.expected,
    "",
    "## Evidence",
    "",
    `- Analyzer: \`${finding.kind}\` (\`src/evolution/analyzers/\`)`,
    `- Subject: \`${finding.subject}\`${location}`,
    `- Severity: ${finding.severity}`,
    `- Detected: ${context.detectedAt.toISOString()}${commit}`,
    `- Finding fingerprint: \`${context.fingerprint}\``,
    "",
    "Reproduce the finding itself with `pnpm audit:self` — it re-runs every analyzer over the current tree and " +
      "prints this finding with the same numbers. If it does NOT reproduce, the finding is already fixed: say so " +
      "and close the issue instead of inventing a change.",
    "",
    "## Files or subsystem in scope",
    "",
    guidance.scope,
    "",
    "## Constraints",
    "",
    "- Smallest correct fix. This issue was filed by a machine and is not evidence that a large change is wanted.",
    "- No file over 400 lines (`pnpm verify:arch` enforces it).",
    "- The test suite runs at $0 — no live model or network calls in tests.",
    "",
    "## Explicitly forbidden",
    "",
    guidance.forbidden,
    "",
    "## Verification commands",
    "",
    "```bash",
    guidance.verify,
    "```",
    "",
    "## Acceptance criteria",
    "",
    guidance.acceptance,
    "",
    "If, after investigating, the correct action is to change nothing — the finding is a false positive, or the " +
      "fix needs a product decision — say that with evidence and stop. A PR that changes code to look productive " +
      "is the failure this loop is most likely to cause, and an honest no-op is a better outcome than an invented " +
      "refactor.",
  ].join("\n");
}
