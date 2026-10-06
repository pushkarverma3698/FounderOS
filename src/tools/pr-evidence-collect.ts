/**
 * FounderOS - PR evidence collectors
 * ==================================
 * Pure mappers from GitHub REST JSON (and vitest JSON reports) to the inputs of pr-evidence.ts.
 * No network, no fs, no clock: scripts/pr-evidence.ts fetches, these only translate. Every mapper
 * returns an error value on input it cannot read, and the caller turns that into UNKNOWN. A
 * mapper never invents data: a required check with no run is a pending check, a locked test the
 * tree does not list stays missing, a report that is not a vitest report is an error.
 */

import { z } from "zod";
import type { CheckRun, DiffFile } from "./pr-evidence.js";

export type Mapped<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const good = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const DEFAULT_REQUIRED_CHECKS: readonly string[] = ["Type check + lint + wiring", "Unit + regression tests"];
/** The CI job that runs vitest and uploads the report; only this check gets test-level results. */
export const TEST_CHECK_NAME = "Unit + regression tests";
export const VITEST_ARTIFACT = "vitest-results";
export const VITEST_REPORT_FILE = "vitest-results.json";

function issuesOf(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message)
    .join("; ");
}

/** gh api --paginate --slurp wraps pages in an array; a single call returns the bare object. */
function pagesOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [raw];
}

// ---------------------------------------------------------------------------------------------
// Check runs
// ---------------------------------------------------------------------------------------------

type Conclusion = CheckRun["conclusion"];
const KNOWN_CONCLUSIONS: readonly string[] = ["success", "failure", "skipped", "cancelled", "neutral", "timed_out", "action_required"];

const RawCheckSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  head_sha: z.string().min(1),
  details_url: z.string().nullable().optional(),
});
const CheckPageSchema = z.object({ check_runs: z.array(RawCheckSchema) });

export interface ParsedCheck {
  id: number;
  name: string;
  status: string;
  /** Limited to what pr-evidence understands; anything else (stale, startup_failure) is null. */
  conclusion: Conclusion;
  headSha: string;
  /** The workflow run id from details_url, or null if it has none. */
  runId: number | null;
}

/** The workflow run id in .../actions/runs/<id>/job/<id>, or null. */
export function runIdOf(detailsUrl: string | null | undefined): number | null {
  const m = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(detailsUrl ?? "");
  return m ? Number(m[1]) : null;
}

/** Check runs for one commit. A run that belongs to a different head is an error, not a skip. */
export function parseCheckRuns(raw: unknown, headSha: string): Mapped<ParsedCheck[]> {
  const out: ParsedCheck[] = [];
  for (const page of pagesOf(raw)) {
    const p = CheckPageSchema.safeParse(page);
    if (!p.success) return bad("check-runs response is not readable: " + issuesOf(p.error));
    for (const c of p.data.check_runs) {
      if (c.head_sha !== headSha) return bad("check run " + c.name + " is for " + c.head_sha + ", not " + headSha);
      const conclusion = c.conclusion != null && KNOWN_CONCLUSIONS.includes(c.conclusion) ? (c.conclusion as Conclusion) : null;
      out.push({ id: c.id, name: c.name, status: c.status, conclusion, headSha: c.head_sha, runId: runIdOf(c.details_url) });
    }
  }
  return good(out);
}

export interface TestResults {
  passedTests: string[];
  failedTests: string[];
}

export interface MapCheckOptions {
  requiredNames: readonly string[];
  /** Test-level results keyed by check-run id. Only the test check (testCheckName) uses them. */
  testsByCheckId?: Record<number, TestResults>;
  testCheckName?: string;
}

/** Worst first. A name with several runs (push and pull_request) takes its worst conclusion. */
const SEVERITY: Conclusion[] = ["failure", "timed_out", "cancelled", "action_required", null, "neutral", "skipped", "success"];

function effective(c: ParsedCheck): Conclusion {
  return c.status === "completed" ? c.conclusion : null;
}

function worst(items: ParsedCheck[]): Conclusion {
  let best: Conclusion = "success";
  for (const c of items) if (SEVERITY.indexOf(effective(c)) < SEVERITY.indexOf(best)) best = effective(c);
  return best;
}

/** Passed = intersection, failed = union. One run without a report leaves both undefined. */
function mergeTests(items: ParsedCheck[], byId: Record<number, TestResults> | undefined): TestResults | undefined {
  if (!byId) return undefined;
  const all: TestResults[] = [];
  for (const c of items) {
    const t = byId[c.id];
    if (!t) return undefined;
    all.push(t);
  }
  const first = all[0];
  if (!first) return undefined;
  const passed = first.passedTests.filter((t) => all.every((a) => a.passedTests.includes(t)));
  const failed = [...new Set(all.flatMap((a) => a.failedTests))];
  return { passedTests: passed, failedTests: failed };
}

export function mapCheckRuns(checks: ParsedCheck[], opts: MapCheckOptions): CheckRun[] {
  const required = new Set(opts.requiredNames);
  const testName = opts.testCheckName ?? TEST_CHECK_NAME;
  const groups = new Map<string, ParsedCheck[]>();
  for (const c of checks) groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
  const out: CheckRun[] = [];
  for (const [name, items] of groups) {
    const run: CheckRun = { name, required: required.has(name), conclusion: worst(items) };
    const tests = name === testName ? mergeTests(items, opts.testsByCheckId) : undefined;
    if (tests) {
      run.passedTests = tests.passedTests;
      run.failedTests = tests.failedTests;
    }
    out.push(run);
  }
  for (const name of opts.requiredNames) if (!groups.has(name)) out.push({ name, required: true, conclusion: null });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

const RawFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previous_filename: z.string().min(1).optional(),
});

const FILE_STATUS: Record<string, DiffFile["status"] | null> = {
  added: "added",
  copied: "added",
  modified: "modified",
  changed: "modified",
  removed: "removed",
  renamed: "renamed",
  unchanged: null,
};

/** GitHub stops listing PR files at 3000: a list that long may be a cut-off one. */
export const PR_FILES_LIMIT = 3000;

function fileList(raw: unknown): unknown[] | null {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Array.isArray((raw as { files?: unknown }).files)) {
    return (raw as { files: unknown[] }).files;
  }
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((e) => (Array.isArray(e) ? e : [e]));
}

/** PR files (or a commit object with `files`) to DiffFile[]. */
export function mapPrFiles(raw: unknown, maxFiles: number = PR_FILES_LIMIT): Mapped<DiffFile[]> {
  const list = fileList(raw);
  if (!list) return bad("files response is not a list of files");
  if (list.length >= maxFiles) return bad("the file list has " + list.length + " entries, which may be cut off by the GitHub API limit of " + maxFiles);
  const out: DiffFile[] = [];
  for (const entry of list) {
    const p = RawFileSchema.safeParse(entry);
    if (!p.success) return bad("a file entry is not readable: " + issuesOf(p.error));
    const status = FILE_STATUS[p.data.status];
    if (status === undefined) return bad("file " + p.data.filename + " has unknown status " + p.data.status);
    if (status === null) continue;
    const file: DiffFile = { path: p.data.filename, status, additions: p.data.additions, deletions: p.data.deletions };
    if (p.data.previous_filename) file.previousPath = p.data.previous_filename;
    out.push(file);
  }
  return good(out);
}

/** A manifest or lockfile in the diff, at any depth, as a path or as a rename source. */
export function dependencyChanged(diff: DiffFile[]): boolean {
  const manifest = (p: string | undefined): boolean => p !== undefined && ["package.json", "pnpm-lock.yaml"].includes(p.slice(p.lastIndexOf("/") + 1));
  return diff.some((f) => manifest(f.path) || manifest(f.previousPath));
}

// ---------------------------------------------------------------------------------------------
// Vitest report
// ---------------------------------------------------------------------------------------------

const VitestReportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string().min(1),
      status: z.string(),
      assertionResults: z.array(z.object({ status: z.string() })).default([]),
    }),
  ),
});

const RUNNER_ROOT = /^\/home\/runner\/work\/[^/]+\/[^/]+\//;

/**
 * The runner checkout prefix, in order of trust: the repoRoot option; the prefix that turns a
 * report path into a locked test path (exact, needs no layout guess); else null (runner layout).
 */
function rootFor(names: string[], lockedTests: readonly string[], repoRoot: string | undefined): string | null {
  if (repoRoot) return repoRoot.replace(/\/+$/, "");
  for (const locked of lockedTests) {
    const hit = names.find((n) => n.endsWith("/" + locked));
    if (hit) return hit.slice(0, hit.length - locked.length - 1);
  }
  return null;
}

/**
 * Vitest JSON report to repo-relative test file paths. A file is passed only if its status is
 * passed, it has at least one assertion, and every assertion passed (a skipped locked test did
 * not run). A file is failed if its status is failed, even with no assertions (an import
 * error), or any assertion failed.
 */
export function mapVitestReport(raw: unknown, opts: { lockedTests: readonly string[]; repoRoot?: string }): Mapped<TestResults> {
  const p = VitestReportSchema.safeParse(raw);
  if (!p.success) return bad("not a vitest JSON report: " + issuesOf(p.error));
  const root = rootFor(
    p.data.testResults.map((t) => t.name),
    opts.lockedTests,
    opts.repoRoot,
  );
  const rel = (name: string): string => {
    if (root && name.startsWith(root + "/")) return name.slice(root.length + 1);
    return name.replace(RUNNER_ROOT, "");
  };
  const passedTests: string[] = [];
  const failedTests: string[] = [];
  for (const t of p.data.testResults) {
    const asserts = t.assertionResults;
    if (t.status === "failed" || asserts.some((a) => a.status === "failed")) failedTests.push(rel(t.name));
    else if (t.status === "passed" && asserts.length > 0 && asserts.every((a) => a.status === "passed")) passedTests.push(rel(t.name));
  }
  return good({ passedTests, failedTests });
}

// ---------------------------------------------------------------------------------------------
// Git tree
// ---------------------------------------------------------------------------------------------

const TreeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), sha: z.string(), type: z.string() })),
});

/** Blob shas for the given paths from GET git/trees/<sha>?recursive=1. A path not listed stays missing. */
export function mapTreeHashes(raw: unknown, paths: readonly string[]): Mapped<Record<string, string>> {
  const p = TreeSchema.safeParse(raw);
  if (!p.success) return bad("git tree response is not readable: " + issuesOf(p.error));
  if (p.data.truncated) return bad("the git tree listing is truncated, so a missing path proves nothing");
  const blobs = new Map(p.data.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha] as const));
  const out: Record<string, string> = {};
  for (const path of paths) {
    const sha = blobs.get(path);
    if (sha) out[path] = sha;
  }
  return good(out);
}
