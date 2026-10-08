/**
 * deploy/promote-run — beta onto prod, one tap.
 *
 * Real git against a local bare "origin" (main and beta with real commits), a stand-in `gh` and `systemctl` on a
 * hermetic PATH. Nothing touches the network. What matters is that every way the run can stop says which step
 * stopped it, and that the happy path ends with a merge commit (`--merge`), never a squash.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROMOTE_RUN = fileURLToPath(new URL("../../../deploy/promote-run", import.meta.url));
const REPO = "pushkarverma3698/FounderOS";

let dir: string;
let betaSha: string;
let mergeSha: string;

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const sh = (name: string, body: string): void => {
  writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
};

const commit = (cwd: string, file: string, content: string, message: string): void => {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "--", file);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
};

interface Setup {
  /** beta changes the same file main changed after the fork. */
  conflict?: boolean;
  /** beta only merges main back: it changes no file main lacks. */
  nothingNew?: boolean;
  betaMovesTo?: string;
  checks?: unknown;
  mergeRc?: number;
  deployConclusion?: string;
  noDeploy?: boolean;
  appAtMerge?: boolean;
  service?: string;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "promote-run-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(o: Setup = {}): { status: number; result: string; calls: string[]; out: string; lockLeft: boolean; createArgs: string } {
  const seed = join(dir, "seed");
  const origin = join(dir, "origin.git");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "a.txt", "a\n", "init");
  git(seed, "checkout", "-q", "-b", "beta");
  if (!o.nothingNew) commit(seed, o.conflict ? "a.txt" : "b.txt", "beta change\n", "feat: the thing (#12)");
  git(seed, "checkout", "-q", "main");
  if (o.conflict) commit(seed, "a.txt", "main change\n", "fix: main side (#13)");
  git(dir, "clone", "-q", "--bare", seed, origin);
  betaSha = git(seed, "rev-parse", "beta");

  const app = join(dir, "app");
  mkdirSync(app);
  git(app, "init", "-q", "-b", "main");
  commit(app, "x", "x\n", "app");
  mergeSha = git(app, "rev-parse", "HEAD");
  if (!o.appAtMerge && o.appAtMerge !== undefined) commit(app, "y", "y\n", "other");

  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(dir, "beta-now"), `${o.betaMovesTo ?? betaSha}\n`);
  writeFileSync(join(dir, "merge-sha"), `${mergeSha}\n`);
  writeFileSync(
    join(dir, "checks.json"),
    JSON.stringify(o.checks ?? [{ name: "Type check + lint + wiring", bucket: "pass" }, { name: "Unit + regression tests", bucket: "pass" }]),
  );
  writeFileSync(
    join(dir, "runs.json"),
    JSON.stringify(
      o.noDeploy ? [] : [{ headSha: mergeSha, status: "completed", conclusion: o.deployConclusion ?? "success", url: "https://gh/run/9" }],
    ),
  );
  sh(
    "gh",
    `echo "gh $*" >>'${calls}'\n` +
      `case "$*" in\n` +
      `  "api repos/"*) cat '${join(dir, "beta-now")}' ;;\n` +
      `  "pr create"*) printf '%s\\n' "$@" >'${join(dir, "create-args")}'; echo "https://github.com/${REPO}/pull/77" ;;\n` +
      `  "pr checks"*) cat '${join(dir, "checks.json")}' ;;\n` +
      `  "pr merge"*) exit ${o.mergeRc ?? 0} ;;\n` +
      `  "pr view"*) cat '${join(dir, "merge-sha")}' ;;\n` +
      `  "run list"*) cat '${join(dir, "runs.json")}' ;;\n` +
      `esac`,
  );
  sh("systemctl", `echo ${o.service ?? "active"}`);

  const resultFile = join(dir, "result");
  const lock = join(dir, "promote.lock");
  const r = spawnSync("bash", [PROMOTE_RUN, "--repo", REPO, "--beta-sha", betaSha, "--result-file", resultFile], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: join(dir, "home"),
      TMPDIR: dir,
      PROMOTE_RUN_CLONE_URL: origin,
      PROMOTE_RUN_POLL: "0",
      PROMOTE_RUN_CHECKS_TIMEOUT: "1",
      PROMOTE_RUN_DEPLOY_TIMEOUT: "1",
      PROMOTE_RUN_APP_DIR: app,
      PROMOTE_RUN_LOCK: lock,
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    timeout: 60_000,
  });
  return {
    status: r.status ?? -1,
    result: existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "",
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
    out: r.stdout + r.stderr,
    lockLeft: existsSync(lock),
    createArgs: existsSync(join(dir, "create-args")) ? readFileSync(join(dir, "create-args"), "utf8") : "",
  };
}

describe("deploy/promote-run", () => {
  it("--help exits 0 (sync-daemons smoke-tests it)", () => {
    const r = spawnSync("bash", [PROMOTE_RUN, "--help"], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/promote-run/);
  });

  it("happy path: PR from origin/main + beta, merged with --merge, deploy green, box at the merge commit", () => {
    const r = run({ appAtMerge: true });

    expect(r.status, r.out).toBe(0);
    expect(r.result).toContain(`On prod: main ${mergeSha.slice(0, 7)}`);
    expect(r.result).toContain("#12");
    expect(r.result).toContain("/pull/77");
    const merge = r.calls.find((c) => c.startsWith("gh pr merge"));
    expect(merge).toContain("--merge");
    expect(merge).not.toContain("--squash");
    expect(merge).toContain("--match-head-commit");
    const create = r.calls.find((c) => c.startsWith("gh pr create"));
    expect(create).toContain("--base main");
    expect(create).toContain(`--head chore/promote-beta-${betaSha.slice(0, 7)}`);
    expect(r.lockLeft).toBe(false);
  });

  it("the PR body carries the three sections and a Moves line (the PR scope check needs it)", () => {
    const r = run({ appAtMerge: true });
    const create = r.createArgs;

    expect(create).toContain("## What changed");
    expect(create).toContain("## How it was verified");
    expect(create).toContain("## NOT VERIFIED");
    expect(create).toContain("Moves: A");
  });

  it("refuses when beta moved since the card: names both commits, opens nothing", () => {
    const moved = "f".repeat(40);
    const r = run({ betaMovesTo: moved });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/Beta moved/);
    expect(r.result).toContain(moved.slice(0, 7));
    expect(r.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
    expect(r.lockLeft).toBe(false);
  });

  it("a merge conflict stops before any PR and lists the files", () => {
    const r = run({ conflict: true });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/does not merge into main/);
    expect(r.result).toContain("a.txt");
    expect(r.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  });

  it("beta that adds no file main lacks is 'nothing to promote', not an empty PR", () => {
    const r = run({ nothingNew: true });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/Nothing to promote/);
    expect(r.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  });

  it("a red required check is reported by name and nothing is merged", () => {
    const r = run({ checks: [{ name: "Unit + regression tests", bucket: "fail" }, { name: "Type check + lint + wiring", bucket: "pass" }] });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/is red: Unit \+ regression tests/);
    expect(r.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("checks that never finish time out without merging", () => {
    const r = run({ checks: [{ name: "Unit + regression tests", bucket: "pending" }] });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/did not finish/);
    expect(r.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("no required checks at all is not green: it waits, then times out", () => {
    const r = run({ checks: [] });

    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("GitHub refusing the merge is reported with its reason and the PR link", () => {
    const r = run({ mergeRc: 1 });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/refused to merge #77/);
    expect(r.result).toContain("/pull/77");
  });

  it("a failed Deploy workflow says prod may still run the old commit", () => {
    const r = run({ deployConclusion: "failure" });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/Deploy workflow ended failure/);
    expect(r.result).toMatch(/old commit/);
  });

  it("a Deploy run that never shows up times out instead of claiming success", () => {
    const r = run({ noDeploy: true });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/did not finish/);
  });

  it("a green deploy but a box at another commit is a failure with both commits", () => {
    const r = run({ appAtMerge: false });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/the box disagrees/);
    expect(r.result).toContain(mergeSha.slice(0, 7));
  });

  it("a green deploy but an inactive service is a failure", () => {
    const r = run({ appAtMerge: true, service: "failed" });

    expect(r.status).toBe(1);
    expect(r.result).toMatch(/founderos is failed/);
  });

  it("a second run while the first is alive says since when and does nothing", () => {
    const lock = join(dir, "promote.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`); // alive: this test process
    writeFileSync(join(lock, "since"), "09:41Z\n");
    const r = run({ appAtMerge: true });

    expect(r.status).toBe(75);
    expect(r.result).toMatch(/Already promoting since 09:41Z/);
    expect(r.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  });

  it("a lock left by a dead run is taken over, not an eternal block", () => {
    const lock = join(dir, "promote.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "999999\n");
    const r = run({ appAtMerge: true });

    expect(r.status, r.out).toBe(0);
  });
});
