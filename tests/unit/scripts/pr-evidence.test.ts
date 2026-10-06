import { describe, it, expect } from "vitest";
import { readOnlyGh, runPrEvidence, type CliDeps, type GhResult } from "../../../scripts/pr-evidence.js";
import { writeContractRecord, type ContractRecord } from "../../../src/tools/contract-store.js";
import { SHA_A, SHA_B, contractFixture } from "../../helpers/contract-fixture.js";
import { memFs, type MemFs } from "../../helpers/mem-fs.js";
import { PR912_HEAD, loadPrEvidenceFixture } from "../../helpers/pr-evidence-fixtures.js";

const T1 = "tests/unit/tools/oracle.test.ts";
const T2 = "tests/unit/tools/oracle-http.test.ts";
const ENV = { AGENT_PIPELINE_V2: "1", FOUNDEROS_CONTRACTS_DIR: "/store" };
const GREEN = ["--repo", "acme/widgets", "--issue", "12", "--pr", "40", "--mode", "green"];
const SPEC = ["--repo", "acme/widgets", "--issue", "12", "--pr", "40", "--mode", "spec"];
const ok: GhResult = { code: 0, stdout: "", stderr: "" };
const json = (v: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
const fail = (msg: string): GhResult => ({ code: 1, stdout: "", stderr: msg });

interface World {
  fs: MemFs;
  calls: string[][];
  deps: CliDeps;
}

/** A fake gh that answers by endpoint. `routes` maps an endpoint substring to a result. */
function world(routes: Record<string, GhResult>, vitest?: unknown): World {
  const fs = memFs();
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "download") {
      if (vitest === undefined) return fail("no artifact named vitest-results");
      const dir = args[args.indexOf("-D") + 1] as string;
      await fs.writeFile(dir + "/vitest-results.json", JSON.stringify(vitest));
      return ok;
    }
    const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
    for (const [needle, res] of Object.entries(routes)) {
      if (endpoint.includes(needle)) return res;
    }
    return fail("unrouted endpoint " + endpoint);
  };
  return { fs, calls, deps: { gh, fs } };
}

function record(over: Partial<ContractRecord> = {}): ContractRecord {
  return {
    version: 1,
    repo: "acme/widgets",
    issue: 12,
    contract: contractFixture({
      scope: ["docs/**", "scripts/post-deploy-oracle.ts", "src/tools/oracle*.ts"],
      locked_tests: [T1, T2],
      limits: { files: 20, lines: 1000, deleted_lines: 50, new_dependencies: false },
      spec_commit: SHA_B,
    }),
    fingerprint: "1".repeat(64),
    approved_at: "2026-10-05T10:00:00.000Z",
    approved_by: "founder",
    spec_commit: SHA_B,
    ...over,
  };
}

function withoutSpecCommit(): ContractRecord {
  const rec = record();
  delete rec.spec_commit;
  delete rec.contract.spec_commit;
  return rec;
}

async function seed(w: World, rec: ContractRecord = record()): Promise<void> {
  const r = await writeContractRecord(w.fs, "/store", rec, () => "seed");
  if (!r.ok) throw new Error(r.error);
}

/** Order matters: the first needle contained in the endpoint wins, so /files comes before the bare PR. */
const greenRoutes = (): Record<string, GhResult> => ({
  "/pulls/40/files": json(loadPrEvidenceFixture("pr912-files.json")),
  "/pulls/40": json({ head: { sha: PR912_HEAD }, base: { sha: SHA_A } }),
  "/check-runs": json(loadPrEvidenceFixture("pr912-check-runs.json")),
  "/git/trees/": json(loadPrEvidenceFixture("pr912-tree.json")),
});

function verdictOf(stdout: string): { status: string; reasons: string[]; head_sha: string; mode?: string } {
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

describe("runPrEvidence: gating and usage", () => {
  it("does nothing, and fetches nothing, unless AGENT_PIPELINE_V2 is 1", async () => {
    for (const flag of [undefined, "0", "true", ""]) {
      const w = world({});
      const r = await runPrEvidence(GREEN, { ...ENV, AGENT_PIPELINE_V2: flag }, w.deps);
      expect(r.code).toBe(0);
      expect(w.calls).toEqual([]);
      const v = verdictOf(r.stdout);
      expect(v.status).toBe("UNKNOWN");
      expect(v.reasons[0]).toMatch(/AGENT_PIPELINE_V2/);
    }
  });
  it("exits 2 with a usage message and no stdout on a bad command line", async () => {
    const bad = [
      [],
      ["--repo", "acme/widgets", "--issue", "12", "--pr", "40"],
      ["--repo", "acme/widgets", "--issue", "12", "--pr", "40", "--mode", "merge"],
      ["--repo", "nope", "--issue", "12", "--pr", "40", "--mode", "green"],
      ["--repo", "acme/widgets", "--issue", "x", "--pr", "40", "--mode", "green"],
      ["--repo", "acme/widgets", "--issue", "12", "--mode", "green"],
      [...GREEN, "--force"],
      [...GREEN, "--repo", "other/x"],
    ];
    for (const argv of bad) {
      const w = world({});
      const r = await runPrEvidence(argv, ENV, w.deps);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/usage/i);
      expect(w.calls).toEqual([]);
    }
  });
  it("a usage error is reported even when the feature flag is off", async () => {
    const r = await runPrEvidence([], { AGENT_PIPELINE_V2: "0" }, world({}).deps);
    expect(r.code).toBe(2);
  });
});

describe("runPrEvidence: green mode", () => {
  it("PASS for the real PR #912 data, one JSON line on stdout, exit 0, and gh is only ever called read-only", async () => {
    const w = world(greenRoutes(), loadPrEvidenceFixture("pr912-vitest-results.json"));
    await seed(w);
    const r = await runPrEvidence(GREEN, ENV, w.deps);
    expect(r.code).toBe(0);
    expect(verdictOf(r.stdout)).toMatchObject({ status: "PASS", reasons: [], head_sha: PR912_HEAD, mode: "green" });
    expect(w.calls.length).toBeGreaterThan(4);
    for (const c of w.calls) {
      const verbs = c[0] === "run" ? c.slice(0, 2).join(" ") : c[0];
      expect(["api", "run download"]).toContain(verbs);
      expect(c.join(" ")).not.toMatch(/(^| )(-X|--method|-f|-F|--field|--raw-field|--input)( |=|$)/);
    }
    // one download per distinct workflow run of the test check, into a temp dir that was then cleaned up
    expect(w.calls.filter((c) => c[0] === "run").map((c) => c[2]).sort()).toEqual(["37348794832", "37348802837"]);
    expect([...w.fs.files.keys()].filter((k) => k.includes("vitest-results"))).toEqual([]);
  });
  it("UNKNOWN, naming the cause, when the vitest-results artifact is missing", async () => {
    const w = world(greenRoutes());
    await seed(w);
    const r = await runPrEvidence(GREEN, ENV, w.deps);
    expect(r.code).toBe(0);
    const v = verdictOf(r.stdout);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons).toEqual(["cannot tell whether the locked test ran: no required check reports which tests passed"]);
  });
  it("FAIL when the artifact shows the locked tests did not run", async () => {
    const other = { testResults: [{ name: "/home/runner/work/R/R/tests/unit/other.test.ts", status: "passed", assertionResults: [{ status: "passed" }] }] };
    const w = world(greenRoutes(), other);
    await seed(w);
    const v = verdictOf((await runPrEvidence(GREEN, ENV, w.deps)).stdout);
    expect(v.status).toBe("FAIL");
    expect(v.reasons).toEqual(expect.arrayContaining(["locked test " + T1 + " did not run in any required check"]));
  });
  it("takes the required check names from PR_EVIDENCE_REQUIRED_CHECKS", async () => {
    const w = world(greenRoutes(), loadPrEvidenceFixture("pr912-vitest-results.json"));
    await seed(w);
    const r = await runPrEvidence(GREEN, { ...ENV, PR_EVIDENCE_REQUIRED_CHECKS: "Unit + regression tests, Mutation tests" }, w.deps);
    const v = verdictOf(r.stdout);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons).toEqual(["required check Mutation tests has no usable result (pending)"]);
  });
  it("UNKNOWN when there is no approved contract for the issue", async () => {
    const w = world(greenRoutes());
    const r = await runPrEvidence(GREEN, ENV, w.deps);
    expect(r.code).toBe(0);
    expect(verdictOf(r.stdout).reasons[0]).toMatch(/contract/);
    expect(w.calls).toEqual([]);
  });
  it("UNKNOWN when the contract has no spec commit to hash the locked tests against", async () => {
    const w = world(greenRoutes(), loadPrEvidenceFixture("pr912-vitest-results.json"));
    await seed(w, withoutSpecCommit());
    const v = verdictOf((await runPrEvidence(GREEN, ENV, w.deps)).stdout);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons[0]).toMatch(/spec_commit/);
  });
  it("UNKNOWN when the contract says a different PR owns this issue", async () => {
    const w = world(greenRoutes());
    await seed(w, record({ pr: 41 }));
    const v = verdictOf((await runPrEvidence(GREEN, ENV, w.deps)).stdout);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons[0]).toMatch(/PR 41/);
  });
  it("UNKNOWN, never a crash, when gh fails or returns junk", async () => {
    const down = world({ "/pulls/40": fail("HTTP 502 bad gateway") });
    await seed(down);
    const r1 = await runPrEvidence(GREEN, ENV, down.deps);
    expect(r1.code).toBe(0);
    expect(verdictOf(r1.stdout).reasons[0]).toMatch(/gh failed.*502/);
    const junk = world({ ...greenRoutes(), "/pulls/40/files": { code: 0, stdout: "<html>", stderr: "" } });
    await seed(junk);
    const v = verdictOf((await runPrEvidence(GREEN, ENV, junk.deps)).stdout);
    expect(v.status).toBe("UNKNOWN");
  });
  it("UNKNOWN when a locked-test path is missing from the tree", async () => {
    const tree = loadPrEvidenceFixture("pr912-tree.json") as { tree: { path: string }[] };
    const trimmed = { ...tree, tree: tree.tree.filter((e) => e.path !== T2) };
    const w = world({ ...greenRoutes(), "/git/trees/": json(trimmed) }, loadPrEvidenceFixture("pr912-vitest-results.json"));
    await seed(w);
    const v = verdictOf((await runPrEvidence(GREEN, ENV, w.deps)).stdout);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons).toEqual(expect.arrayContaining(["no spec-time hash for locked test " + T2 + ": cannot prove it is unchanged"]));
  });
});

describe("runPrEvidence: spec mode", () => {
  const SPEC_SHA = SHA_B;
  const specChecks = (testConclusion: string) => ({
    total_count: 2,
    check_runs: [
      { id: 1, name: "Type check + lint + wiring", status: "completed", conclusion: "success", head_sha: SPEC_SHA, details_url: "https://github.com/a/b/actions/runs/500/job/1" },
      { id: 2, name: "Unit + regression tests", status: "completed", conclusion: testConclusion, head_sha: SPEC_SHA, details_url: "https://github.com/a/b/actions/runs/501/job/2" },
    ],
  });
  const commit = (paths: string[]) => ({ sha: SPEC_SHA, files: paths.map((p) => ({ filename: p, status: "added", additions: 10, deletions: 0 })) });
  const redReport = (failing: string) => ({
    testResults: [
      { name: "/home/runner/work/R/R/" + failing, status: "failed", assertionResults: [{ status: "failed" }] },
      { name: "/home/runner/work/R/R/tests/unit/tools/oracle-http.test.ts", status: "passed", assertionResults: [{ status: "passed" }] },
    ],
  });

  it("PASS for a spec commit that adds only locked tests and turns a locked test red", async () => {
    const w = world({ "/check-runs": json(specChecks("failure")), "/commits/": json(commit([T1, T2])) }, redReport(T1));
    await seed(w);
    const r = await runPrEvidence(SPEC, ENV, w.deps);
    expect(r.code).toBe(0);
    expect(verdictOf(r.stdout)).toMatchObject({ status: "PASS", reasons: [], head_sha: SPEC_SHA, mode: "spec" });
    expect(w.calls.some((c) => c.some((a) => a.includes("/commits/" + SPEC_SHA + "/check-runs")))).toBe(true);
  });
  it("FAIL when the spec commit touches a file that is not a locked test", async () => {
    const w = world({ "/check-runs": json(specChecks("failure")), "/commits/": json(commit([T1, "src/tools/oracle.ts"])) }, redReport(T1));
    await seed(w);
    const v = verdictOf((await runPrEvidence(SPEC, ENV, w.deps)).stdout);
    expect(v.status).toBe("FAIL");
    expect(v.reasons).toEqual(["spec commit touches src/tools/oracle.ts, which is not a locked test"]);
  });
  it("UNKNOWN when the contract has no spec commit yet", async () => {
    const w = world({});
    await seed(w, withoutSpecCommit());
    const v = verdictOf((await runPrEvidence(SPEC, ENV, w.deps)).stdout);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons[0]).toMatch(/spec_commit/);
  });
});

describe("readOnlyGh", () => {
  const seen: string[][] = [];
  const inner = async (args: string[]): Promise<GhResult> => {
    seen.push(args);
    return ok;
  };
  const guarded = readOnlyGh(inner);
  it("passes GET api calls and run download", async () => {
    expect((await guarded(["api", "repos/a/b/pulls/1"])).code).toBe(0);
    expect((await guarded(["api", "-X", "GET", "repos/a/b"])).code).toBe(0);
    expect((await guarded(["api", "--paginate", "--slurp", "repos/a/b/pulls/1/files"])).code).toBe(0);
    expect((await guarded(["run", "download", "1", "-R", "a/b", "-n", "x", "-D", "/work/d"])).code).toBe(0);
    expect(seen).toHaveLength(4);
  });
  it("refuses every write verb without calling gh", async () => {
    seen.length = 0;
    const writes = [
      ["api", "-X", "POST", "repos/a/b/issues"],
      ["api", "-XPATCH", "repos/a/b/pulls/1"],
      ["api", "--method=DELETE", "repos/a/b"],
      ["api", "--method", "put", "repos/a/b"],
      ["api", "repos/a/b/issues", "-f", "title=x"],
      ["api", "repos/a/b/issues", "-F", "a=b"],
      ["api", "repos/a/b/issues", "--field", "a=b"],
      ["api", "repos/a/b/issues", "--raw-field=a=b"],
      ["api", "repos/a/b/issues", "--input", "body.json"],
      ["api", "graphql"],
      ["pr", "merge", "1"],
      ["pr", "comment", "1"],
      ["run", "rerun", "1"],
      ["issue", "edit", "1"],
      [],
    ];
    for (const a of writes) {
      const r = await guarded(a);
      expect(r.code, a.join(" ")).not.toBe(0);
      expect(r.stderr).toMatch(/read-only/);
    }
    expect(seen).toEqual([]);
  });
});

