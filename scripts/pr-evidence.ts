/**
 * PR evidence CLI. Reads the approved contract for an issue, reads the PR (or the spec commit)
 * from GitHub through a read-only gh, and prints ONE JSON line: the evidence verdict plus the
 * mode, repo, issue and pr it was computed for. It decides nothing: canMerge and the founder do.
 *
 *   node --import tsx/esm scripts/pr-evidence.ts --repo owner/name --issue N --pr P --mode spec|green
 *
 * Exit 0 for any verdict (PASS, FAIL and UNKNOWN alike), exit 2 on a usage error. Every failure
 * to read something becomes UNKNOWN with the cause, never a crash and never a PASS.
 * With AGENT_PIPELINE_V2 not equal to 1 it prints a one-line UNKNOWN notice and fetches nothing.
 *
 * Env: FOUNDEROS_CONTRACTS_DIR (contract store), PR_EVIDENCE_REQUIRED_CHECKS (comma list, default
 * "Type check + lint + wiring,Unit + regression tests").
 * Test-level results come from the vitest-results artifact that CI uploads; without it they stay
 * unknown and the verdict is UNKNOWN.
 */

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { contractFileName, contractsDir, readContractRecord, type ContractRecord, type StoreFs } from "../src/tools/contract-store.js";
import { verifyImplementationGreen, verifySpecRed, type EvidenceVerdict } from "../src/tools/pr-evidence.js";
import {
  DEFAULT_REQUIRED_CHECKS,
  TEST_CHECK_NAME,
  VITEST_ARTIFACT,
  VITEST_REPORT_FILE,
  dependencyChanged,
  mapCheckRuns,
  mapPrFiles,
  mapTreeHashes,
  mapVitestReport,
  parseCheckRuns,
  type Mapped,
  type ParsedCheck,
  type TestResults,
} from "../src/tools/pr-evidence-collect.js";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GhRunner = (args: string[]) => Promise<GhResult>;
export interface CliFs extends StoreFs {
  mkdtemp(prefix: string): Promise<string>;
}
export interface CliDeps {
  gh: GhRunner;
  fs: CliFs;
}
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: pr-evidence.ts --repo owner/name --issue N [--pr P] --mode spec|green   (--pr is required for green)";

// ---------------------------------------------------------------------------------------------
// gh guard: this script can read GitHub and download an artifact, nothing else
// ---------------------------------------------------------------------------------------------

const refuse = (why: string): GhResult => ({ code: 126, stdout: "", stderr: "refused: pr-evidence is read-only: " + why });

/** Wraps a gh runner so only GET api calls on repos/ endpoints and run download get through. */
export function readOnlyGh(inner: GhRunner): GhRunner {
  return async (args) => {
    if (args[0] === "run") {
      if (args[1] === "download" && /^\d+$/.test(args[2] ?? "")) return inner(args);
      return refuse("only `run download <id>` is allowed, got `run " + (args[1] ?? "") + "`");
    }
    if (args[0] !== "api") return refuse("only `api` and `run download` are allowed, got `" + (args[0] ?? "") + "`");
    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i] as string;
      if (a === "--paginate" || a === "--slurp") continue;
      let method: string | undefined;
      if (a === "-X" || a === "--method") method = args[++i];
      else if (a.startsWith("--method=")) method = a.slice("--method=".length);
      else if (a.startsWith("-X")) method = a.slice(2);
      else if (a.startsWith("-")) return refuse("flag " + a + " is not allowed");
      else {
        positional.push(a);
        continue;
      }
      if ((method ?? "").toUpperCase() !== "GET") return refuse("method " + (method ?? "(none)") + " is not GET");
    }
    if (positional.length !== 1 || !(positional[0] as string).startsWith("repos/")) return refuse("api needs exactly one repos/ endpoint");
    return inner(args);
  };
}

export const execGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || err.message });
    });
  });

const realFs: CliFs = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p, o) => {
    await fsp.mkdir(p, o);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

interface Args {
  repo: string;
  issue: number;
  pr?: number;
  mode: "spec" | "green";
}

function parseArgs(argv: string[]): Mapped<Args> {
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!["--repo", "--issue", "--pr", "--mode"].includes(flag)) return { ok: false, error: "unknown argument " + flag };
    if (value === undefined || value.startsWith("--")) return { ok: false, error: flag + " needs a value" };
    if (seen.has(flag)) return { ok: false, error: flag + " given twice" };
    seen.set(flag, value);
  }
  const repo = seen.get("--repo");
  const mode = seen.get("--mode");
  const issue = seen.get("--issue");
  const pr = seen.get("--pr");
  if (mode !== "spec" && mode !== "green") return { ok: false, error: "--mode must be spec or green" };
  if (!repo || !issue || !/^[1-9]\d*$/.test(issue)) return { ok: false, error: "--repo and a positive integer --issue are required" };
  if (!contractFileName(repo, Number(issue)).ok) return { ok: false, error: "--repo must look like owner/name" };
  if (pr !== undefined && !/^[1-9]\d*$/.test(pr)) return { ok: false, error: "--pr must be a positive integer" };
  if (mode === "green" && pr === undefined) return { ok: false, error: "--pr is required for green mode" };
  return { ok: true, value: { repo, issue: Number(issue), mode, ...(pr !== undefined ? { pr: Number(pr) } : {}) } };
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

const unknown = (reason: string, head = "unknown"): EvidenceVerdict => ({ status: "UNKNOWN", reasons: [reason], head_sha: head });

function emit(v: EvidenceVerdict, a: Args): CliResult {
  const body = { ...v, mode: a.mode, repo: a.repo, issue: a.issue, ...(a.pr !== undefined ? { pr: a.pr } : {}) };
  return { code: 0, stdout: JSON.stringify(body) + "\n", stderr: "" };
}

async function ghJson(gh: GhRunner, args: string[]): Promise<Mapped<unknown>> {
  const label = args.find((x) => x.startsWith("repos/")) ?? args.join(" ");
  const r = await gh(args);
  if (r.code !== 0) return { ok: false, error: "gh failed (exit " + r.code + ") for " + label + ": " + r.stderr.trim().slice(0, 200) };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as unknown };
  } catch {
    return { ok: false, error: "gh returned output that is not JSON for " + label };
  }
}

const PrSchema = z.object({ head: z.object({ sha: z.string().min(1) }), base: z.object({ sha: z.string().min(1) }) });

const requiredNames = (env: Record<string, string | undefined>): string[] => {
  const names = (env.PR_EVIDENCE_REQUIRED_CHECKS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  return names.length > 0 ? names : [...DEFAULT_REQUIRED_CHECKS];
};

/** One artifact download per workflow run. A missing or unreadable artifact is null, which leaves the tests unknown. */
async function fetchReport(deps: CliDeps, repo: string, runId: number, root: string, locked: string[]): Promise<TestResults | null> {
  const dir = root + "/" + runId;
  const r = await deps.gh(["run", "download", String(runId), "-R", repo, "-n", VITEST_ARTIFACT, "-D", dir]);
  if (r.code !== 0) return null;
  try {
    const mapped = mapVitestReport(JSON.parse(await deps.fs.readFile(dir + "/" + VITEST_REPORT_FILE)) as unknown, { lockedTests: locked });
    return mapped.ok ? mapped.value : null;
  } catch {
    // allow-failopen: no readable report leaves passedTests undefined, which the engine turns into UNKNOWN
    return null;
  }
}

async function testsByCheck(deps: CliDeps, repo: string, checks: ParsedCheck[], root: string, locked: string[]): Promise<Record<number, TestResults>> {
  const candidates = checks.filter((c) => c.name === TEST_CHECK_NAME && c.status === "completed" && c.runId !== null);
  const byRun = new Map<number, TestResults | null>();
  for (const c of candidates) {
    const runId = c.runId as number;
    if (!byRun.has(runId)) byRun.set(runId, await fetchReport(deps, repo, runId, root, locked));
  }
  const out: Record<number, TestResults> = {};
  for (const c of candidates) {
    const t = byRun.get(c.runId as number);
    if (t) out[c.id] = t;
  }
  return out;
}

interface Ctx {
  a: Args;
  deps: CliDeps;
  root: string;
  rec: ContractRecord;
  specCommit: string;
  required: string[];
}

async function checksAt(c: Ctx, sha: string): Promise<Mapped<ReturnType<typeof mapCheckRuns>>> {
  const raw = await ghJson(c.deps.gh, ["api", "--paginate", "--slurp", "repos/" + c.a.repo + "/commits/" + sha + "/check-runs?per_page=100"]);
  if (!raw.ok) return raw;
  const parsed = parseCheckRuns(raw.value, sha);
  if (!parsed.ok) return parsed;
  const tests = await testsByCheck(c.deps, c.a.repo, parsed.value, c.root, c.rec.contract.locked_tests);
  return { ok: true, value: mapCheckRuns(parsed.value, { requiredNames: c.required, testsByCheckId: tests }) };
}

async function hashesAt(c: Ctx, sha: string): Promise<Mapped<Record<string, string>>> {
  const raw = await ghJson(c.deps.gh, ["api", "repos/" + c.a.repo + "/git/trees/" + sha + "?recursive=1"]);
  return raw.ok ? mapTreeHashes(raw.value, c.rec.contract.locked_tests) : raw;
}

async function specMode(c: Ctx): Promise<EvidenceVerdict> {
  const sha = c.specCommit;
  const checks = await checksAt(c, sha);
  if (!checks.ok) return unknown(checks.error, sha);
  const commit = await ghJson(c.deps.gh, ["api", "repos/" + c.a.repo + "/commits/" + sha]);
  if (!commit.ok) return unknown(commit.error, sha);
  const files = mapPrFiles(commit.value, 300);
  if (!files.ok) return unknown(files.error, sha);
  return verifySpecRed({ ...c.rec.contract, spec_commit: sha }, { head_sha: sha, checks: checks.value, specCommitFiles: files.value });
}

async function greenMode(c: Ctx): Promise<EvidenceVerdict> {
  const pr = c.a.pr as number;
  const prRaw = await ghJson(c.deps.gh, ["api", "repos/" + c.a.repo + "/pulls/" + pr]);
  if (!prRaw.ok) return unknown(prRaw.error);
  const prInfo = PrSchema.safeParse(prRaw.value);
  if (!prInfo.success) return unknown("pull request response has no head and base sha");
  const head = prInfo.data.head.sha;
  const filesRaw = await ghJson(c.deps.gh, ["api", "--paginate", "--slurp", "repos/" + c.a.repo + "/pulls/" + pr + "/files?per_page=100"]);
  if (!filesRaw.ok) return unknown(filesRaw.error, head);
  const diff = mapPrFiles(filesRaw.value);
  if (!diff.ok) return unknown(diff.error, head);
  const checks = await checksAt(c, head);
  if (!checks.ok) return unknown(checks.error, head);
  const atSpec = await hashesAt(c, c.specCommit);
  if (!atSpec.ok) return unknown(atSpec.error, head);
  const atHead = await hashesAt(c, head);
  if (!atHead.ok) return unknown(atHead.error, head);
  return verifyImplementationGreen(
    { ...c.rec.contract, spec_commit: c.specCommit },
    { head_sha: head, checks: checks.value, diff: diff.value, lockedTestHashes: { atSpec: atSpec.value, atHead: atHead.value }, dependencyChanged: dependencyChanged(diff.value) },
  );
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

export async function runPrEvidence(argv: string[], env: Record<string, string | undefined>, deps: CliDeps): Promise<CliResult> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return { code: 2, stdout: "", stderr: parsed.error + "\n" + USAGE + "\n" };
  const a = parsed.value;
  if (env.AGENT_PIPELINE_V2 !== "1") return emit(unknown("AGENT_PIPELINE_V2 is not 1: pr-evidence is off, nothing was read"), a);

  const stored = await readContractRecord(deps.fs, contractsDir(env), a.repo, a.issue);
  if (!stored.ok) return emit(unknown("no usable contract for " + a.repo + "#" + a.issue + ": " + stored.error), a);
  const rec = stored.value;
  if (a.pr !== undefined && rec.pr !== undefined && rec.pr !== a.pr) {
    return emit(unknown("the contract belongs to PR " + rec.pr + ", not PR " + a.pr), a);
  }
  const specCommit = rec.spec_commit ?? rec.contract.spec_commit;
  if (!specCommit) return emit(unknown("the contract has no spec_commit yet: no spec-time test hashes to compare against"), a);

  const root = await deps.fs.mkdtemp(posix.join(tmpdir(), "pr-evidence-"));
  const ctx: Ctx = { a, deps: { gh: readOnlyGh(deps.gh), fs: deps.fs }, root, rec, specCommit, required: requiredNames(env) };
  try {
    return emit(a.mode === "spec" ? await specMode(ctx) : await greenMode(ctx), a);
  } finally {
    try {
      await deps.fs.rm(root);
    } catch {
      // allow-failopen: leftover temp files are harmless, and the verdict is already computed
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrEvidence(process.argv.slice(2), process.env, { gh: execGh, fs: realFs }).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.code);
  });
}
