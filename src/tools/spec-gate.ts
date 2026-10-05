/**
 * FounderOS — spec gate
 * =====================
 * Pure check of a parsed TaskContract before any code is written. It either passes the spec or
 * returns founder-readable QUESTIONS. It never repairs a spec and never guesses a plan: no
 * citable `path:line` means a question (docs/plans/2026-10-05-coding-pipeline-thin-slice.md
 * section 5).
 *
 * No fs, no git, no clock. File existence and the repo's risk globs are injected, so the same
 * function runs offline in CI and against a real checkout.
 *
 * WHAT IT CHECKS
 *  1. Every citation is on `base_sha`, in a repo-relative path, and the file has that line there.
 *  2. Locked tests are test files, and none of them sits inside `scope` (the builder must not be
 *     able to edit the test that judges it).
 *  3. `scope` is non-empty, repo-relative, and does not reach CI, lint, dependency or
 *     verification config.
 *  4. `task_type` is one of the supported three.
 *  5. effectiveRisk = max(model risk, "high" if scope overlaps a risk path). Code only raises.
 *  6. fingerprint: stable sha256 of the parts that define the task, for keying budgets.
 *
 * Globs: `**` crosses directories, `*` and `?` do not. Overlap between two globs is decided by a
 * conservative static-prefix rule, so it can over-report (and raise risk or ask) but never
 * under-report. A scope with no directory prefix (`**`, `*`, a double-star plus an extension) is
 * therefore asked about: the task must name directories.
 */
import { createHash } from "node:crypto";
import { TASK_TYPES, renderCitation } from "./task-contract.js";
import type { Citation, Risk, TaskContract } from "./task-contract.js";

export interface SpecGateDeps {
  /** Line count of `path` at commit `sha`, or null when the file does not exist there. */
  fileLineCount(path: string, sha: string): number | null;
  /** Globs of paths whose change is always high risk (money, auth, schema, deploy...). */
  riskPaths: string[];
}

export interface SpecGateResult {
  status: "PASS" | "ASK";
  questions: string[];
  effectiveRisk: Risk;
  fingerprint: string;
}

/**
 * Root-anchored patterns a task must never be allowed to edit: it could weaken its own judge.
 * pr-evidence.ts checks the built diff against the same list.
 */
export const PROTECTED_PATHS: readonly string[] = [
  ".github/**",
  "governance/**",
  ".husky/**",
  "package.json",
  "pnpm-lock.yaml",
  ".npmrc",
  "eslint*",
  ".eslintrc*",
  "tsconfig*",
  "vitest.config*",
  "vitest.workspace*",
  "vitest.setup*",
  "scripts/verify-*",
];
const FORBIDDEN_SCOPE = PROTECTED_PATHS;

const RISK_ORDER: readonly Risk[] = ["low", "medium", "high"];

// ---------------------------------------------------------------- globs

function hasWildcard(g: string): boolean {
  return /[*?]/.test(g);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

function staticPrefix(g: string): string {
  const i = g.search(/[*?]/);
  return i === -1 ? g : g.slice(0, i);
}

/** True when some path could match both globs. Conservative: may say yes when the answer is no. */
export function globsOverlap(a: string, b: string): boolean {
  const aw = hasWildcard(a);
  const bw = hasWildcard(b);
  if (!aw && !bw) return a === b;
  if (!aw) return globMatches(b, a);
  if (!bw) return globMatches(a, b);
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

// ---------------------------------------------------------------- paths

/** Repo-relative: no blank, no backslash, no absolute or home or drive prefix, no `..` segment. */
function isRepoRelative(p: string): boolean {
  if (p.trim() === "" || p.includes("\\")) return false;
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split("/").includes("..");
}

function isTestFile(p: string): boolean {
  return p.startsWith("tests/") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

function reachesForbidden(entry: string): boolean {
  if (FORBIDDEN_SCOPE.some((f) => globsOverlap(entry, f))) return true;
  // A literal file with a forbidden name at any depth (packages/web/package.json).
  const base = entry.slice(entry.lastIndexOf("/") + 1);
  if (hasWildcard(base)) return false;
  return FORBIDDEN_SCOPE.filter((f) => !f.includes("/")).some((f) => globMatches(f, base));
}

// ---------------------------------------------------------------- checks

function citationQuestions(c: TaskContract, deps: SpecGateDeps): string[] {
  const cits: Citation[] = c.current_behavior.citations;
  const base7 = c.base_sha.slice(0, 7);
  if (cits.length === 0) {
    return ["No citable path:line was given for the current behavior. Which file and line shows what happens today?"];
  }
  const out: string[] = [];
  for (const cit of cits) {
    const ref = renderCitation(cit);
    if (cit.sha !== c.base_sha) {
      out.push(`Citation ${ref} is not on the base commit ${base7}. Which line of ${cit.path} at ${base7} shows the current behavior?`);
    } else if (!isRepoRelative(cit.path)) {
      out.push(`Citation ${ref} is not a path inside the repo. Which repo file and line shows the current behavior?`);
    } else {
      const lines = deps.fileLineCount(cit.path, cit.sha);
      if (lines === null) {
        out.push(`Citation ${ref} points at a file that does not exist at the base commit ${base7}. Which file shows the current behavior?`);
      } else if (cit.line > lines) {
        out.push(`Citation ${ref} is past the end of the file (it has ${lines} lines at ${base7}). Which line of ${cit.path} shows the current behavior?`);
      }
    }
  }
  return out;
}

function lockedTestQuestions(c: TaskContract): string[] {
  if (c.locked_tests.length === 0) return ["No locked test was named. Which test file should prove this change works?"];
  const out: string[] = [];
  for (const t of c.locked_tests) {
    if (!isRepoRelative(t) || !isTestFile(t)) {
      out.push(`Locked test "${t}" is not a test file (expected tests/** or *.test.ts / *.spec.ts). Which test should lock this behavior?`);
    } else if (c.scope.some((s) => s.trim() !== "" && globMatches(s, t))) {
      out.push(`Locked test "${t}" is also inside the change scope, so the builder could edit the test that judges it. Narrow the scope or pick another test.`);
    }
  }
  return out;
}

function scopeQuestions(c: TaskContract): string[] {
  if (c.scope.length === 0) return ["The change scope is empty. Which files may this change touch?"];
  const out: string[] = [];
  for (const s of c.scope) {
    if (!isRepoRelative(s)) {
      out.push(`Scope entry ${JSON.stringify(s)} is not a repo-relative path (no "..", no absolute paths, no backslashes, not blank). Which files may this change touch?`);
    } else if (reachesForbidden(s)) {
      out.push(`Scope entry "${s}" could let the change edit CI, lint, dependency or verification config. Name the source files or directories instead.`);
    }
  }
  return out;
}

function taskTypeQuestions(c: TaskContract): string[] {
  if ((TASK_TYPES as readonly string[]).includes(c.task_type)) return [];
  return [`Task type "${String(c.task_type)}" is not supported yet (${TASK_TYPES.join(", ")}). Which of those is it, or should a person do this one?`];
}

function effectiveRiskOf(c: TaskContract, riskPaths: string[]): Risk {
  const raised = c.scope.some((s) => riskPaths.some((r) => globsOverlap(s, r)));
  const model = RISK_ORDER.indexOf(c.risk);
  const floor = raised ? RISK_ORDER.indexOf("high") : 0;
  // An unknown risk string (a contract that skipped the schema) resolves to "high", never lower.
  return RISK_ORDER[model === -1 ? 2 : Math.max(model, floor)] ?? "high";
}

function normalizeAsk(ask: string): string {
  return ask.normalize("NFC").replace(/\s+/g, " ").trim();
}

function fingerprintOf(c: TaskContract): string {
  const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();
  const material = JSON.stringify([
    "founderos.task-contract.v1",
    c.repo,
    c.base_sha,
    normalizeAsk(c.ask),
    sortedUnique(c.scope),
    sortedUnique(c.locked_tests),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** Run every check. Pure: the input is not mutated and nothing outside `deps` is read. */
export function runSpecGate(contract: TaskContract, deps: SpecGateDeps): SpecGateResult {
  const questions = [
    ...taskTypeQuestions(contract),
    ...citationQuestions(contract, deps),
    ...scopeQuestions(contract),
    ...lockedTestQuestions(contract),
  ];
  return {
    status: questions.length === 0 ? "PASS" : "ASK",
    questions,
    effectiveRisk: effectiveRiskOf(contract, deps.riskPaths),
    fingerprint: fingerprintOf(contract),
  };
}
