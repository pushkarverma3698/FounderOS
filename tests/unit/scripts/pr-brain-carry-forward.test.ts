/**
 * pr-brain must not re-gate its own work — deploy/vps-daemons/pr-brain.
 * =====================================================================
 * Every gate is a full Claude session on the founder's personal account
 * (2026-09-28/29 prod: 80–175 model calls, 4–12M cached tokens each). The
 * marker is stamped with the head the gate STARTED on, so a gate that pushed a
 * fix moved the head and the next sweep gated it again: founderos#763 was gated
 * 7 times in 6 hours, 4 of them over nothing but pr-brain's own commits and a
 * clean merge of beta. The account then sat at its session limit for ~9 hours.
 *
 * These run the real script against a real git history (a local bare repo
 * stands in for GitHub) and stub `claude`/`gh`, counting Claude sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));
const BRAIN = ["-c", "user.name=FounderOS Brain", "-c", "user.email=brain@founderos.ai"];
const AGY = ["-c", "user.name=FounderOS Antigravity", "-c", "user.email=agy@founderos.ai"];

let root: string;
let home: string;
let bin: string;
let repo: string;
let bare: string;
let ghCalls: string;
let claudeCalls: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(who: string[], file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(["add", file]);
  git([...who, "commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** Publish the PR head (refs/pull/56/head) and beta to the bare "GitHub". */
function publish(head: string): void {
  git(["push", "-q", "--force", bare, `${head}:refs/pull/56/head`, "beta:refs/heads/beta"]);
}

function sweep(head: string, gatedAt: string): void {
  spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: home,
      PR_BRAIN_OWNER: "owner",
      QA_APP_ROOT: join(root, "no-founderos"),
      FAKE_HEAD: head,
      FAKE_COMMENTS: `<!-- brain-reviewed: ${gatedAt} -->`,
      GH_CALLS: ghCalls,
      CLAUDE_CALLS: claudeCalls,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const claudeSessions = () => (existsSync(claudeCalls) ? readFileSync(claudeCalls, "utf8").split("\n").filter(Boolean) : []);
const ghLog = () => (existsSync(ghCalls) ? readFileSync(ghCalls, "utf8") : "");
const brainLog = () => readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");

let gated: string; // the Antigravity head the last real gate reviewed

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-cf-"));
  home = join(root, "home");
  bin = join(root, "bin");
  repo = join(root, "review", "founderos");
  bare = join(root, "remote", "owner", "founderos.git");
  ghCalls = join(root, "gh-calls.log");
  claudeCalls = join(root, "claude-calls.log");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  // An explicit repo list, so the stand-in remote need not be github.com.
  writeFileSync(join(home, ".claude", "pr-brain.repos"), `${repo}\n`);

  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["init", "-q", "-b", "beta"]);
  git(["config", "user.name", "FounderOS Brain"]);
  git(["config", "user.email", "brain@founderos.ai"]);
  git(["remote", "add", "origin", bare]);
  commit(AGY, "base.txt", "base\n", "base");
  git(["checkout", "-q", "-b", "task/issue-762"]);
  gated = commit(AGY, "feature.ts", "export const x = 1;\n", "feat: antigravity work");

  stub("claude", `[ -t 0 ] || cat >/dev/null\necho call >>"$CLAUDE_CALLS"\necho ok`);
  stub(
    "gh",
    `echo "$*" >>"$GH_CALLS"
case "$*" in
  "api user"*) echo owner ;;
  "auth status"*) exit 0 ;;
  "pr list"*) echo "56 $FAKE_HEAD" ;;
  *"headRefOid"*) echo "$FAKE_HEAD" ;;
  *"--json comments"*) echo "$FAKE_COMMENTS" ;;
  *"reviewDecision"*) echo "CLEARED — marked ready for merge · title" ;;
  *"baseRefName"*) echo beta ;;
  *) exit 0 ;;
esac`,
  );
  stub("curl", "exit 0");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pr-brain — carrying a verdict forward over its own commits", () => {
  it("spends no Claude session when the only news is pr-brain's own fix and a clean merge of beta", () => {
    commit(BRAIN, "feature.ts", "export const x = 2;\n", "fix(review): brain's own fix");
    git(["checkout", "-q", "beta"]);
    commit(AGY, "other.txt", "beta moved on\n", "unrelated beta commit");
    git(["checkout", "-q", "task/issue-762"]);
    git([...BRAIN, "merge", "-q", "--no-edit", "beta"]);
    const head = git(["rev-parse", "HEAD"]);
    publish(head);

    sweep(head, gated);

    expect(claudeSessions()).toHaveLength(0);
    expect(brainLog()).toMatch(/carried forward/);
    // Stamped at the new head, so the next sweep skips it outright.
    expect(ghLog()).toContain(`pr comment 56 --body <!-- brain-reviewed: ${head} -->`);
    // Already cleared → the merge is attempted without a new review.
    expect(ghLog()).toMatch(/pr merge 56 --squash/);
  });

  it("still gates when anyone else pushed since the last gate", () => {
    const head = commit(AGY, "feature.ts", "export const x = 3;\n", "antigravity pushes again");
    publish(head);

    sweep(head, gated);

    expect(claudeSessions().length).toBeGreaterThan(0);
    expect(brainLog()).toMatch(/gating founderos#56/);
    expect(brainLog()).not.toMatch(/carried forward/);
  });

  it("still gates a merge of beta that resolved a conflict by hand", () => {
    git(["checkout", "-q", "beta"]);
    commit(AGY, "feature.ts", "export const x = 99;\n", "beta edits the same line");
    git(["checkout", "-q", "task/issue-762"]);
    spawnSync("git", [...BRAIN, "merge", "-q", "beta"], { cwd: repo });
    writeFileSync(join(repo, "feature.ts"), "export const x = 100; // hand-resolved\n");
    git(["add", "feature.ts"]);
    git([...BRAIN, "commit", "-q", "--no-edit"]);
    const head = git(["rev-parse", "HEAD"]);
    publish(head);

    sweep(head, gated);

    expect(claudeSessions().length).toBeGreaterThan(0);
    expect(brainLog()).not.toMatch(/carried forward/);
  });

  it("still gates when the gated head is no longer in the history (force-push)", () => {
    git(["reset", "-q", "--hard", "beta"]);
    const head = commit(BRAIN, "feature.ts", "export const x = 4;\n", "rewritten history");
    publish(head);

    sweep(head, gated);

    expect(claudeSessions().length).toBeGreaterThan(0);
    expect(brainLog()).not.toMatch(/carried forward/);
  });
});
