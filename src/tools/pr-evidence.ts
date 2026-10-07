/**
 * FounderOS - PR evidence engine
 * ==============================
 * Code, not a model, decides whether a PR proves its task. Pure: no network, no fs, no clock.
 * A caller fetches plain data from the GitHub API (check runs, the file diff, locked-test
 * hashes) and these functions turn it into a verdict.
 *
 * WHY. The dispatcher checked "EXISTENCE, not correctness", "no CI counted as green" was a
 * real defect, and pr-brain once wrote GATE PASSED after targeted vitest only. Plan:
 * docs/plans/2026-09-30-coding-pipeline-v2.md section 6.
 *
 * THE INVARIANT. A verdict is derived from a list of findings, each FAIL or UNKNOWN, each with a
 * reason. No findings -> PASS; any FAIL -> FAIL; otherwise UNKNOWN. There is no code path that
 * turns UNKNOWN into PASS, and a non-PASS verdict always carries at least one reason. Anything
 * the engine cannot read (malformed input, a pending check, a missing hash) is UNKNOWN, never PASS.
 *
 * The contract fields this engine reads are a Pick of TaskContract (src/tools/task-contract.ts);
 * the protected-path list and the glob matcher are the spec gate's (src/tools/spec-gate.ts).
 *
 * Every verdict carries the head sha it was computed for, and canMerge refuses evidence for any
 * other head.
 */

import { z } from "zod";
import { TaskContractSchema } from "./task-contract.js";
import type { TaskContract } from "./task-contract.js";
import { inScope, isTestPath, norm, protectedReason, unsafePath } from "./pr-evidence-paths.js";

export type EvidenceStatus = "PASS" | "FAIL" | "UNKNOWN";
export interface EvidenceVerdict {
  status: EvidenceStatus;
  reasons: string[];
  /** The head these checks and this diff were read at. canMerge refuses any other head. */
  head_sha: string;
}

const CONCLUSIONS = ["success", "failure", "skipped", "cancelled", "neutral", "timed_out", "action_required"] as const;

const CheckRunSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  conclusion: z.enum(CONCLUSIONS).nullable(),
  /** Test file paths parsed from the run, if known. Absent = unknown; empty = known to be none. */
  failedTests: z.array(z.string()).optional(),
  /** Test file paths that ran and passed in this run. Absent = unknown; empty = known to be none. */
  passedTests: z.array(z.string()).optional(),
});

const DiffFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previousPath: z.string().min(1).optional(),
});

const EVIDENCE_SPEC_KEYS = { locked_tests: true, scope: true, limits: true, base_sha: true, spec_commit: true } as const;
/** The contract fields this engine reads. Extra keys on a full contract are ignored. */
export const EvidenceSpecSchema = TaskContractSchema.pick(EVIDENCE_SPEC_KEYS).strip();

const HashMapSchema = z.record(z.string(), z.string());

export type CheckRun = z.infer<typeof CheckRunSchema>;
export type DiffFile = z.infer<typeof DiffFileSchema>;
export type EvidenceSpec = Pick<TaskContract, "locked_tests" | "scope" | "limits" | "base_sha" | "spec_commit">;

export interface SpecRedInput {
  /** The spec commit being judged. */
  head_sha: string;
  checks: CheckRun[];
  /** Files changed by the spec (test) commit alone. */
  specCommitFiles: DiffFile[];
}
export interface ImplementationGreenInput {
  /** The PR head being judged. */
  head_sha: string;
  checks: CheckRun[];
  /** Files changed between base and head. */
  diff: DiffFile[];
  lockedTestHashes: { atSpec: Record<string, string>; atHead: Record<string, string> };
  dependencyChanged: boolean;
}

const SpecRedInputSchema = z.object({ head_sha: z.string().min(1), checks: z.array(CheckRunSchema), specCommitFiles: z.array(DiffFileSchema) });
const GreenInputSchema = z.object({
  head_sha: z.string().min(1),
  checks: z.array(CheckRunSchema),
  diff: z.array(DiffFileSchema),
  lockedTestHashes: z.object({ atSpec: HashMapSchema, atHead: HashMapSchema }),
  dependencyChanged: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Findings -> verdict
// ---------------------------------------------------------------------------------------------

interface Finding {
  level: "FAIL" | "UNKNOWN";
  reason: string;
}

class Findings {
  private readonly list: Finding[] = [];
  fail(reason: string): void {
    this.list.push({ level: "FAIL", reason: reason || "unspecified failure" });
  }
  unknown(reason: string): void {
    this.list.push({ level: "UNKNOWN", reason: reason || "unspecified unknown" });
  }
  verdict(head_sha: string): EvidenceVerdict {
    const status: EvidenceStatus =
      this.list.length === 0 ? "PASS" : this.list.some((f) => f.level === "FAIL") ? "FAIL" : "UNKNOWN";
    return { status, reasons: this.list.map((f) => f.reason), head_sha };
  }
}

function unknownVerdict(reason: string, head_sha: string): EvidenceVerdict {
  return { status: "UNKNOWN", reasons: [reason], head_sha };
}

/** The head sha of raw, possibly malformed input, or empty when it cannot be read. */
function headOf(input: unknown): string {
  const h = (input as { head_sha?: unknown } | null | undefined)?.head_sha;
  return typeof h === "string" ? h : "";
}

function describeIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message)
    .join("; ");
}

// ---------------------------------------------------------------------------------------------
// Check runs
// ---------------------------------------------------------------------------------------------

/** Folds required checks into findings; returns the failed ones so callers can inspect them. */
function scanRequiredChecks(f: Findings, checks: CheckRun[]): { required: number; failed: CheckRun[]; allSuccess: boolean } {
  const required = checks.filter((c) => c.required);
  const failed: CheckRun[] = [];
  let allSuccess = true;
  if (required.length === 0) {
    f.unknown("no required checks reported: the absence of CI is not a pass");
    allSuccess = false;
  }
  for (const c of required) {
    if (c.conclusion === "success") continue;
    allSuccess = false;
    if (c.conclusion === "failure" || c.conclusion === "timed_out") failed.push(c);
    else f.unknown("required check " + c.name + " has no usable result (" + (c.conclusion ?? "pending") + ")");
  }
  return { required: required.length, failed, allSuccess };
}

// ---------------------------------------------------------------------------------------------
// verifySpecRed: the test commit
// ---------------------------------------------------------------------------------------------

/**
 * The spec commit adds or changes ONLY locked tests, at least one required check fails, every
 * failing test is a locked test, and every other required check is green. Otherwise FAIL or UNKNOWN.
 */
export function verifySpecRed(spec: EvidenceSpec, input: SpecRedInput): EvidenceVerdict {
  const head = headOf(input);
  const s = EvidenceSpecSchema.safeParse(spec);
  if (!s.success) return unknownVerdict("invalid contract: " + describeIssues(s.error), head);
  const i = SpecRedInputSchema.safeParse(input);
  if (!i.success) return unknownVerdict("invalid spec-commit evidence: " + describeIssues(i.error), head);
  if (s.data.locked_tests.length === 0) return unknownVerdict("the contract has no locked tests", head);

  const locked = new Set(s.data.locked_tests.map(norm));
  const f = new Findings();

  if (i.data.specCommitFiles.length === 0) {
    f.unknown("the spec commit file list is empty: cannot tell what it changed");
  }
  for (const file of i.data.specCommitFiles) {
    const touched = file.previousPath ? [file.path, file.previousPath] : [file.path];
    for (const p of touched) {
      if (unsafePath(p)) f.fail("spec commit touches an unsafe path: " + p);
      else if (!locked.has(norm(p))) f.fail("spec commit touches " + p + ", which is not a locked test");
    }
    if (file.status === "removed" || file.status === "renamed") {
      f.fail("spec commit must only add or change locked tests, but " + file.path + " was " + file.status);
    }
  }

  const scan = scanRequiredChecks(f, i.data.checks);
  if (scan.required > 0 && scan.allSuccess) {
    f.fail("no required check failed: the locked tests do not fail on the unmodified base, so they prove nothing");
  }
  let lockedFailing = 0;
  let unreadable = false;
  for (const c of scan.failed) {
    if (c.failedTests === undefined) {
      unreadable = true;
      f.unknown("required check " + c.name + " failed and cannot tell which tests failed");
      continue;
    }
    if (c.failedTests.length === 0) {
      f.fail("required check " + c.name + " failed with no failing test (a lint, type or build break), so its red is not the locked test's");
      continue;
    }
    for (const t of c.failedTests) {
      if (locked.has(norm(t))) lockedFailing++;
      else f.fail("non-locked test " + t + " fails at spec time (check " + c.name + ")");
    }
  }
  if (scan.failed.length > 0 && !unreadable && lockedFailing === 0) {
    f.fail("none of the failing tests is a locked test");
  }
  return f.verdict(i.data.head_sha);
}

// ---------------------------------------------------------------------------------------------
// verifyImplementationGreen: the head
// ---------------------------------------------------------------------------------------------

/**
 * Every locked test must be named in `passedTests` of a required success check: green CI that
 * never ran the locked test proves nothing. No check says (all undefined) is UNKNOWN; a list
 * that omits a locked test is FAIL.
 */
function requireLockedTestsRan(f: Findings, checks: CheckRun[], lockedTests: string[]): void {
  const ok = checks.filter((c) => c.required && c.conclusion === "success");
  if (ok.length === 0) return; // scanRequiredChecks has already said why
  const reporting = ok.filter((c) => c.passedTests !== undefined);
  if (reporting.length === 0) {
    f.unknown("cannot tell whether the locked test ran: no required check reports which tests passed");
    return;
  }
  for (const t of lockedTests.map(norm)) {
    const ran = reporting.some((c) => (c.passedTests ?? []).map(norm).includes(t));
    if (!ran) f.fail("locked test " + t + " did not run in any required check");
  }
}

/**
 * All required checks green and the locked tests actually run, locked tests byte-identical, no
 * existing non-locked test changed or deleted (new test files are fine), no CI/lint/type/
 * test-config/manifest/verify-script edits, every non-test file inside scope, limits held, and
 * no new dependency. Test files are exempt from the scope globs, not from any other rule. The
 * limits bound the executor's change: locked tests are Pass P's, pinned by hash, and not counted.
 */
export function verifyImplementationGreen(spec: EvidenceSpec, input: ImplementationGreenInput): EvidenceVerdict {
  const head = headOf(input);
  const s = EvidenceSpecSchema.safeParse(spec);
  if (!s.success) return unknownVerdict("invalid contract: " + describeIssues(s.error), head);
  const i = GreenInputSchema.safeParse(input);
  if (!i.success) return unknownVerdict("invalid head evidence: " + describeIssues(i.error), head);
  const f = new Findings();
  const { locked_tests, scope, limits } = s.data;
  const lockedSet = new Set(locked_tests.map(norm));

  const scan = scanRequiredChecks(f, i.data.checks);
  for (const c of scan.failed) f.fail("required check " + c.name + " is " + c.conclusion);
  requireLockedTestsRan(f, i.data.checks, locked_tests);

  const hashes = i.data.lockedTestHashes;
  for (const t of locked_tests.map(norm)) {
    const atSpec = hashes.atSpec[t];
    const atHead = hashes.atHead[t];
    if (!atSpec) f.unknown("no spec-time hash for locked test " + t + ": cannot prove it is unchanged");
    else if (!atHead) f.unknown("no head hash for locked test " + t + ": cannot prove it is unchanged");
    else if (atSpec !== atHead) f.fail("locked test " + t + " was modified after the spec commit (hash differs)");
  }

  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const file of i.data.diff) {
    if (!lockedSet.has(norm(file.path))) {
      files++;
      additions += file.additions;
      deletions += file.deletions;
    }
    const touched = file.previousPath ? [file.path, file.previousPath] : [file.path];
    for (const p of touched) {
      const path = norm(p);
      if (unsafePath(path)) {
        f.fail("diff contains an unsafe path: " + p);
        continue;
      }
      const why = protectedReason(path);
      if (why) {
        f.fail(p + " is " + why + ", which an executor may not change");
        continue;
      }
      const existing = file.status === "modified" || file.status === "removed" || (file.status === "renamed" && p === file.previousPath);
      if (existing && isTestPath(path) && !lockedSet.has(path)) {
        f.fail("existing test " + p + " changed: put it in locked_tests via a new spec");
      }
      if (!isTestPath(path) && !inScope(scope, path)) f.fail(p + " is outside the contract scope");
    }
  }

  if (files > limits.files) f.fail("diff touches " + files + " files, over the limit of " + limits.files);
  if (additions > limits.lines) f.fail("diff adds " + additions + " lines, over the limit of " + limits.lines);
  if (deletions > limits.deleted_lines) {
    f.fail("diff deletes " + deletions + " lines, over the limit of " + limits.deleted_lines);
  }
  if (i.data.dependencyChanged) f.fail("a dependency was added or changed (new dependencies are not allowed)");
  return f.verdict(i.data.head_sha);
}

// ---------------------------------------------------------------------------------------------
// canMerge and the merge key
// ---------------------------------------------------------------------------------------------

const MergeInputSchema = z.object({
  evidence: z.object({ status: z.enum(["PASS", "FAIL", "UNKNOWN"]), reasons: z.array(z.string()), head_sha: z.string().min(1) }),
  review: z.object({ decision: z.enum(["APPROVE", "REQUEST_CHANGES", "UNKNOWN"]), head_sha: z.string().min(1) }),
  headAtReview: z.string().min(1),
  headNow: z.string().min(1),
  baseAtReview: z.string().min(1),
  baseNow: z.string().min(1),
});

export type MergeInput = z.input<typeof MergeInputSchema>;
export interface MergeDecision {
  ok: boolean;
  reasons: string[];
}

/**
 * True only if the evidence is PASS, the review is APPROVE for the head that is there now, and
 * neither head nor base moved since the review, and the evidence was computed for the head being
 * merged. Fail-closed: malformed input is a refusal.
 */
export function canMerge(input: MergeInput): MergeDecision {
  const p = MergeInputSchema.safeParse(input);
  if (!p.success) {
    return { ok: false, reasons: ["invalid merge input: " + describeIssues(p.error)] };
  }
  const { evidence, review, headAtReview, headNow, baseAtReview, baseNow } = p.data;
  const reasons: string[] = [];
  if (evidence.status !== "PASS") {
    reasons.push("evidence is " + evidence.status + ": " + (evidence.reasons.join("; ") || "no reason given"));
  } else if (evidence.reasons.length > 0) {
    reasons.push("evidence says PASS but carries reasons, so it is inconsistent: " + evidence.reasons.join("; "));
  }
  if (evidence.head_sha !== headNow) {
    reasons.push("evidence was computed for head " + evidence.head_sha + " but the PR head is " + headNow);
  }
  if (review.decision !== "APPROVE") reasons.push("review decision is " + review.decision + ", not APPROVE");
  if (review.head_sha !== headNow) {
    reasons.push("review was for head " + review.head_sha + " but the PR head is " + headNow);
  }
  if (headAtReview !== headNow) reasons.push("head moved since review (" + headAtReview + " to " + headNow + ")");
  if (review.head_sha !== headAtReview) reasons.push("review head_sha does not match the head recorded at review time");
  if (baseAtReview !== baseNow) reasons.push("base moved since review (" + baseAtReview + " to " + baseNow + ")");
  return { ok: reasons.length === 0, reasons };
}

/** Idempotency key for the merge call, so a retry for the same head cannot merge twice. */
export function mergeIdempotencyKey(repo: string, pr: number, head: string): string {
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) throw new Error("mergeIdempotencyKey: repo must be owner/name, got " + repo);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("mergeIdempotencyKey: pr must be a positive integer, got " + pr);
  if (!head || /\s/.test(head)) throw new Error("mergeIdempotencyKey: head must be a non-empty sha");
  return "merge:" + repo + "#" + pr + "@" + head;
}
