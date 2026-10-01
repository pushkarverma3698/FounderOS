/**
 * `pnpm branch:new <type> <slug>` — a branch cut from FETCHED origin/main, named to the grammar.
 * =============================================================================================
 * The incident this exists for: branches cut from a stale LOCAL main dragged a day of
 * already-merged history into new PRs. The command fetches first, branches from `origin/main`
 * (never `main`), refuses names the branch verifier would reject, and then runs the verifier.
 *
 * Everything runs against a throwaway world in the OS temp dir: a bare "origin", a seed clone
 * that advances it, and a working clone whose local `main` and `origin/main` are both stale.
 * No network. The sandbox's own git config (GIT_CONFIG_COUNT, signing) is stripped so the
 * repos behave the same here as in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENT_PREFIXES,
  BRANCH_TYPES,
  MAX_BRANCH_LENGTH,
  runBranchNew,
  validateBranchRequest,
} from "../../../scripts/branch-new.js";

const REAL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VERIFY_SCRIPT = join(REAL_ROOT, "scripts", "verify-branch-name.sh");
/** tsx by absolute URL: the CLI runs with a temp repo as its cwd, where `--import tsx/esm` cannot resolve. */
const TSX = pathToFileURL(join(REAL_ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;

/** A git environment that ignores the machine's own config, so the sandbox and CI agree. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_") && key !== "GIT_CONFIG_GLOBAL") delete env[key];
  delete env["GITHUB_HEAD_REF"];
  delete env["AGENT_PREFIX"];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commits a file and returns the new commit's sha. */
function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

interface World {
  readonly dir: string;
  readonly origin: string;
  readonly seed: string;
  readonly work: string;
  /** main as `work` last knew it (both local main and origin/main). */
  readonly staleMain: string;
  /** main on origin now: one commit ahead of what `work` has. */
  readonly freshMain: string;
}

/**
 * origin (bare) ← seed pushes A then B.  work cloned when origin was at A, then origin advanced to B.
 * So in `work`: local main = A, origin/main = A (stale), and the real origin/main = B.
 */
function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), "branch-new-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const work = join(dir, "work");

  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", seed);
  git(seed, "remote", "add", "origin", origin);
  const staleMain = commit(seed, "README.md", "one\n", "A: first");
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, work);
  const freshMain = commit(seed, "README.md", "one\ntwo\n", "B: merged on origin after work cloned");
  git(seed, "push", "-q", "origin", "main");

  return { dir, origin, seed, work, staleMain, freshMain };
}

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => {
  rmSync(world.dir, { recursive: true, force: true });
});

const run = (over: { type?: string; slug?: string; agentPrefix?: string; cwd?: string; verifyScript?: string } = {}) =>
  runBranchNew({
    type: over.type ?? "fix",
    slug: over.slug ?? "retry-budget",
    agentPrefix: over.agentPrefix ?? "",
    cwd: over.cwd ?? world.work,
    env: cleanEnv(),
    verifyScript: over.verifyScript ?? VERIFY_SCRIPT,
  });

const head = (): string => git(world.work, "rev-parse", "HEAD");
const branchName = (): string => git(world.work, "rev-parse", "--abbrev-ref", "HEAD");
const branches = (): string[] => git(world.work, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
const originMainAsWorkSeesIt = (): string => git(world.work, "rev-parse", "origin/main");

describe("branching from FETCHED origin/main, never a stale local main", () => {
  it("starts the branch at the commit origin/main has NOW, not the one local main and the old origin/main still hold", () => {
    expect(originMainAsWorkSeesIt()).toBe(world.staleMain);
    expect(git(world.work, "rev-parse", "main")).toBe(world.staleMain);

    const result = run();

    expect(result.code).toBe(0);
    expect(branchName()).toBe("fix/retry-budget");
    expect(head()).toBe(world.freshMain);
    expect(head()).not.toBe(world.staleMain);
    // The fetch moved origin/main; local main was never touched.
    expect(originMainAsWorkSeesIt()).toBe(world.freshMain);
    expect(git(world.work, "rev-parse", "main")).toBe(world.staleMain);
    expect(result.out.join("\n")).toContain(`origin/main at ${world.freshMain.slice(0, 7)}`);
  });

  it("does not drag local-only commits on main into the new branch (the incident)", () => {
    git(world.work, "switch", "-q", "main");
    const stray = commit(world.work, "stray.txt", "local only\n", "C: never pushed, sitting on local main");

    const result = run();

    expect(result.code).toBe(0);
    expect(head()).toBe(world.freshMain);
    const contains = spawnSync("git", ["merge-base", "--is-ancestor", stray, "HEAD"], { cwd: world.work, env: cleanEnv() });
    expect(contains.status).toBe(1);
  });

  it("gives the new branch no upstream, so a bare `git push` can never target main", () => {
    run();
    const upstream = spawnSync("git", ["config", "--get", "branch.fix/retry-budget.remote"], { cwd: world.work, env: cleanEnv(), encoding: "utf8" });
    expect(upstream.status).toBe(1);
    expect(upstream.stdout).toBe("");
  });

  it("carries uncommitted work onto the new branch and says how much", () => {
    writeFileSync(join(world.work, "README.md"), "one\nmid-edit\n");
    writeFileSync(join(world.work, "scratch.txt"), "untracked\n");

    // README.md differs between A and B, so git refuses the switch rather than lose the edit:
    // that refusal must reach the founder verbatim, with the branch NOT created.
    const conflicting = run();
    expect(conflicting.code).toBe(1);
    expect(conflicting.err.join("\n")).toContain("README.md");
    expect(branches()).not.toContain("fix/retry-budget");

    git(world.work, "checkout", "-q", "--", "README.md");
    const result = run();
    expect(result.code).toBe(0);
    expect(readFileSync(join(world.work, "scratch.txt"), "utf8")).toBe("untracked\n");
    expect(result.out.join("\n")).toContain("1 uncommitted change came with you");
  });

  it("prefixes the branch with AGENT_PREFIX, and leaves a human's branch as <type>/<slug>", () => {
    expect(run({ agentPrefix: "claude" }).code).toBe(0);
    expect(branchName()).toBe("claude/fix-retry-budget");

    git(world.work, "switch", "-q", "main");
    expect(run({ type: "feat", slug: "goals-standup", agentPrefix: "cursor" }).code).toBe(0);
    expect(branchName()).toBe("cursor/feat-goals-standup");

    git(world.work, "switch", "-q", "main");
    expect(run({ type: "docs", slug: "branch-naming-rules", agentPrefix: "antigravity" }).code).toBe(0);
    expect(branchName()).toBe("antigravity/docs-branch-naming-rules");

    git(world.work, "switch", "-q", "main");
    expect(run({ type: "chore", slug: "prune-merged-branches" }).code).toBe(0);
    expect(branchName()).toBe("chore/prune-merged-branches");
  });

  it("then runs verify:branch, and prints what it said", () => {
    const result = run();
    expect(result.out.join("\n")).toContain("verify:branch — OK: 'fix/retry-budget'");
  });

  it("reports a verifier that rejects the branch, and leaves the branch for a rename", () => {
    const strict = join(world.dir, "strict-verify.sh");
    writeFileSync(strict, "#!/usr/bin/env bash\necho \"verify:branch — FAIL: nope\"\nexit 1\n");
    const result = run({ verifyScript: strict });

    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("verify:branch — FAIL: nope");
    expect(result.err.join("\n")).toContain("git branch -m");
    expect(branches()).toContain("fix/retry-budget");
  });
});

describe("refusing a bad name before any network call", () => {
  it.each([
    ["an unknown type", { type: "feature", slug: "retry-budget" }, /type "feature" is not one of/],
    ["a one-word slug", { type: "fix", slug: "bug" }, /2 or more words/],
    ["uppercase", { type: "fix", slug: "Retry-Budget" }, /lowercase/],
    ["an underscore", { type: "fix", slug: "retry_budget" }, /letters, digits and hyphens/],
    ["a slash in the slug", { type: "fix", slug: "retry/budget" }, /letters, digits and hyphens/],
    ["a leading hyphen", { type: "fix", slug: "-retry-budget" }, /start or end with|empty word/],
    ["a doubled hyphen", { type: "fix", slug: "retry--budget" }, /start or end with|empty word/],
    ["a bad AGENT_PREFIX", { type: "fix", slug: "retry-budget", agentPrefix: "gemini" }, /AGENT_PREFIX="gemini" is not one of/],
    ["a name over the limit", { type: "fix", slug: `${"word-".repeat(12)}end` }, /limit is 60/],
  ])("%s", (_label, input, message) => {
    const before = originMainAsWorkSeesIt();
    const result = run(input);

    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(message);
    expect(branches()).toEqual(["main"]);
    // No fetch happened: origin/main is still exactly what it was.
    expect(originMainAsWorkSeesIt()).toBe(before);
  });

  it.each(["sweet-pike-6b0c3c", "wonderful-spence-d76aa2", "sad-burnell-86737c", "funny-fermat-552ryl", "portfolio-ai-audit-kjik0f"])(
    "rejects the harness codename %s and says what to do instead",
    (slug) => {
      const result = run({ slug, agentPrefix: "claude" });

      expect(result.code).toBe(2);
      const text = result.err.join("\n");
      expect(text).toContain("harness codename");
      expect(text).toContain("names nothing");
      expect(text).toContain("Name the subject of the work");
      expect(branches()).toEqual(["main"]);
    },
  );

  it("does not mistake an ordinary slug for a codename", () => {
    for (const slug of ["fix-jobhunt-cv-claim-guard", "rag-pipeline-upgrade", "add-sha256-verify", "node22-upgrade"]) {
      expect(validateBranchRequest({ type: "chore", slug, agentPrefix: "" }).ok).toBe(true);
    }
  });

  it("knows its one false positive, and says how to get past it: a real word shaped like a hash, last", () => {
    // `node22` is indistinguishable from `ac9712` by shape (BRANCHING-STRATEGY.md's own example of a
    // harness hash), so a slug that ENDS in such a word is refused. Putting a word after it is the fix.
    const verdict = validateBranchRequest({ type: "chore", slug: "upgrade-to-node22", agentPrefix: "" });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join("\n")).toContain("put another word after it");
    expect(validateBranchRequest({ type: "chore", slug: "upgrade-to-node22-runtime", agentPrefix: "" }).ok).toBe(true);
  });

  it("lists every problem at once, each with its own reason", () => {
    const verdict = validateBranchRequest({ type: "feature", slug: "Bug", agentPrefix: "gemini" });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("a branch name that already exists", () => {
  it("says so plainly when it exists locally, and points at `git switch` for continuing that work", () => {
    git(world.work, "branch", "fix/retry-budget");
    const result = run();

    expect(result.code).toBe(1);
    const text = result.err.join("\n");
    expect(text).toContain('Branch "fix/retry-budget" already exists in this checkout');
    expect(text).toContain("git switch fix/retry-budget");
    expect(text).toContain("different slug");
    expect(branchName()).toBe("main");
  });

  it("says so when it exists on origin, where a same-named branch would be rejected at push", () => {
    git(world.seed, "switch", "-q", "-c", "fix/retry-budget");
    commit(world.seed, "other.txt", "x\n", "someone else's work");
    git(world.seed, "push", "-q", "origin", "fix/retry-budget");

    const result = run();

    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain('Branch "fix/retry-budget" already exists on origin');
    expect(branches()).toEqual(["main"]);
  });
});

describe("failing loudly instead of branching from something stale", () => {
  it("refuses when origin/main cannot be fetched, and never falls back to the stale ref", () => {
    git(world.work, "remote", "set-url", "origin", join(world.dir, "does-not-exist.git"));
    const result = run();

    expect(result.code).toBe(1);
    const text = result.err.join("\n");
    expect(text).toContain("git fetch origin main failed");
    expect(text).toContain("Refusing to branch from a possibly stale origin/main");
    expect(branches()).toEqual(["main"]);
    expect(branchName()).toBe("main");
  });

  it("refuses outside a git repository", () => {
    const result = run({ cwd: world.dir });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("not inside a git repository");
  });

  it("refuses when there is no origin remote", () => {
    git(world.work, "remote", "remove", "origin");
    const result = run();

    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("no 'origin' remote");
  });
});

describe("the grammar is the verifier's grammar", () => {
  const verifier = (branch: string): number =>
    spawnSync("bash", [VERIFY_SCRIPT], { env: { ...cleanEnv(), GITHUB_HEAD_REF: branch }, encoding: "utf8" }).status ?? -1;

  it("uses the same types, agent prefixes and length limit as scripts/verify-branch-name.sh", () => {
    const script = readFileSync(VERIFY_SCRIPT, "utf8");
    const types = /^TYPES='([^']+)'/m.exec(script)?.[1]?.split("|");
    const agents = /^AGENTS='([^']+)'/m.exec(script)?.[1]?.split("|");
    const max = Number(/^MAX_LEN=(\d+)/m.exec(script)?.[1]);

    expect(types).toEqual([...BRANCH_TYPES]);
    expect(agents).toEqual([...AGENT_PREFIXES]);
    expect(max).toBe(MAX_BRANCH_LENGTH);
  });

  it("only ever produces names the verifier accepts", () => {
    for (const type of BRANCH_TYPES) {
      for (const agentPrefix of ["", ...AGENT_PREFIXES]) {
        const verdict = validateBranchRequest({ type, slug: "jobhunt-cv-claim-guard", agentPrefix });
        expect(verdict.ok).toBe(true);
        if (verdict.ok) expect(verifier(verdict.branch)).toBe(0);
      }
    }
  });

  it("draws the length line where the verifier does: exactly 60 characters passes, 61 does not", () => {
    // "fix/" + 56 characters = 60; "claude/fix-" + 49 = 60.
    const fits = [
      { type: "fix", slug: `${"a".repeat(27)}-${"b".repeat(28)}`, agentPrefix: "" },
      { type: "fix", slug: `${"a".repeat(24)}-${"b".repeat(24)}`, agentPrefix: "claude" },
    ];
    for (const input of fits) {
      const verdict = validateBranchRequest(input);
      expect(verdict.ok, JSON.stringify(input)).toBe(true);
      if (verdict.ok) {
        expect(verdict.branch.length).toBe(MAX_BRANCH_LENGTH);
        expect(verifier(verdict.branch)).toBe(0);
      }
      const tooLong = { ...input, slug: `${input.slug}c` };
      const over = validateBranchRequest(tooLong);
      expect(over.ok, JSON.stringify(tooLong)).toBe(false);
      const name = tooLong.agentPrefix ? `${tooLong.agentPrefix}/${tooLong.type}-${tooLong.slug}` : `${tooLong.type}/${tooLong.slug}`;
      expect(name.length).toBe(MAX_BRANCH_LENGTH + 1);
      expect(verifier(name)).toBe(1);
    }
  });

  it("refuses everything the verifier refuses, and the verifier agrees each one is wrong", () => {
    const cases: Array<{ type: string; slug: string; agentPrefix: string }> = [
      { type: "fix", slug: "bug", agentPrefix: "" },
      { type: "fix", slug: "Retry-Budget", agentPrefix: "" },
      { type: "fix", slug: "retry_budget", agentPrefix: "" },
      { type: "fix", slug: "retry--budget", agentPrefix: "claude" },
      { type: "fix", slug: `${"word-".repeat(12)}end`, agentPrefix: "" },
      { type: "feature", slug: "retry-budget", agentPrefix: "" },
    ];
    for (const input of cases) {
      const verdict = validateBranchRequest(input);
      expect(verdict.ok, JSON.stringify(input)).toBe(false);
      const name = input.agentPrefix ? `${input.agentPrefix}/${input.type}-${input.slug}` : `${input.type}/${input.slug}`;
      expect(verifier(name), `verifier on ${name}`).toBe(1);
    }
  });

  it("is stricter than the verifier only on harness codenames, which the verifier lets through by design", () => {
    const codename = { type: "fix", slug: "sweet-pike-6b0c3c", agentPrefix: "claude" };
    expect(validateBranchRequest(codename).ok).toBe(false);
    // BRANCHING-STRATEGY.md: a trailing harness hash is "allowed and ignored" by the verifier, so it
    // cannot be the thing that stops a codename; this command is.
    expect(verifier("claude/fix-sweet-pike-6b0c3c")).toBe(0);
  });
});

describe("the CLI (spawned for real, in the temp world)", () => {
  const cli = (cwd: string, args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", TSX, join(REAL_ROOT, "scripts", "branch-new.ts"), ...args], {
      cwd,
      env: { ...cleanEnv(), ...extraEnv },
      encoding: "utf8",
      timeout: 60_000,
    });

  it("creates the branch from fetched origin/main and exits 0", () => {
    const result = cli(world.work, ["fix", "retry-budget"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created fix/retry-budget");
    expect(result.stdout).toContain("verify:branch — OK");
    expect(head()).toBe(world.freshMain);
  });

  it("reads AGENT_PREFIX from the environment", () => {
    const result = cli(world.work, ["fix", "retry-budget"], { AGENT_PREFIX: "claude" });

    expect(result.status).toBe(0);
    expect(branchName()).toBe("claude/fix-retry-budget");
  });

  it("rejects a harness codename with exit 2 and the reason on stderr", () => {
    const result = cli(world.work, ["fix", "sweet-pike-6b0c3c"], { AGENT_PREFIX: "claude" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("harness codename");
    expect(branches()).toEqual(["main"]);
  });

  it("explains how to pass a multi-word slug when given loose words", () => {
    const result = cli(world.work, ["fix", "jobhunt", "cv", "claim", "guard"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm branch:new <type> <slug>");
    expect(result.stderr).toContain("fix jobhunt-cv-claim-guard");
  });

  it("prints usage for no arguments", () => {
    const result = cli(world.work, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm branch:new <type> <slug>");
  });
});
