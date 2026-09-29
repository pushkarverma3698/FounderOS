/**
 * agent-dispatch must back off when Antigravity's quota is exhausted —
 * deploy/agent-dispatch.
 * ====================================================================
 * 2026-09-21 07:45–08:31 (VPS agent-dispatch.log): issue #710 was claimed and
 * run 5 times in 46 minutes. Every run died on the same line — "Individual
 * quota reached … Resets in 57h37m" — and every run marked the issue
 * agent:failed, as if the TASK had failed. Nothing in the script read the
 * reset time, so each tick (and each /task kick) walked into the same wall.
 *
 * These run the real script against stub gh/sudo/agy binaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url));
const QUOTA_LINE =
  "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s.";

let root: string;
let home: string;
let bin: string;
let ghCalls: string;
let agyCalls: string;

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function tick(agyOutput = QUOTA_LINE): void {
  spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: home,
      ISSUE_REPOS: "owner/founderos",
      AGENT_DISPATCH_WORKSPACE_BASE: join(root, "ws"),
      AGENT_DISPATCH_ENV_FILE: join(root, "none.env"),
      AGENT_DISPATCH_PROGRESS_POLL_SEC: "0",
      GH_CALLS: ghCalls,
      AGY_CALLS: agyCalls,
      AGY_OUT: agyOutput,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const agyRuns = () => (existsSync(agyCalls) ? readFileSync(agyCalls, "utf8").split("\n").filter(Boolean).length : 0);
const ghLog = () => (existsSync(ghCalls) ? readFileSync(ghCalls, "utf8") : "");
const dispatchLog = () => readFileSync(join(home, ".claude", "agent-dispatch.log"), "utf8");
const quotaFile = () => join(home, ".claude", "agent-dispatch.quota-until");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-dispatch-"));
  home = join(root, "home");
  bin = join(root, "bin");
  ghCalls = join(root, "gh-calls.log");
  agyCalls = join(root, "agy-calls.log");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  // Workspace: a real checkout whose origin has main, like /opt/agy-workspace/<repo>.
  const bare = join(root, "origin.git");
  const ws = join(root, "ws", "founderos");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", ws]);
  execFileSync("git", ["-C", ws, "remote", "add", "origin", bare]);
  writeFileSync(join(ws, "README.md"), "x\n");
  execFileSync("git", ["-C", ws, "add", "."]);
  execFileSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", ws, "push", "-q", "origin", "main"]);
  execFileSync("git", ["-C", ws, "fetch", "-q", "origin"]);

  // sudo -u antigravity -- bash -lc SCRIPT _ args  →  run it as ourselves.
  stub("sudo", `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
  stub("timeout", `shift; exec "$@"`); // coreutils timeout is not on macOS
  stub("agy", `echo run >>"$AGY_CALLS"; printf '%s\\n' "$AGY_OUT"; exit 1`);
  stub(
    "gh",
    `echo "$*" >>"$GH_CALLS"
case "$*" in
  "auth status"*) exit 0 ;;
  "issue list"*"agent:ready"*) echo 710 ;;
  "issue list"*) : ;;
  "issue view"*"title"*) echo "test(docs): add visible test comment" ;;
  "issue view"*"body"*) echo "Add a line to README.md" ;;
  "pr list"*"--head"*) : ;;
  "pr list"*) echo "[]" ;;
  *) exit 0 ;;
esac`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("agent-dispatch — Antigravity quota exhausted", () => {
  it("puts the issue back to agent:ready (not agent:failed) and records when the quota resets", () => {
    tick();

    expect(agyRuns()).toBe(1);
    expect(ghLog()).toMatch(/issue edit 710 .*--remove-label agent:working --add-label agent:ready/);
    expect(ghLog()).not.toMatch(/--add-label agent:failed/);
    const until = Number(readFileSync(quotaFile(), "utf8").trim());
    const expected = Date.now() / 1000 + (57 * 3600 + 37 * 60 + 44);
    expect(Math.abs(until - expected)).toBeLessThan(120);
  });

  it("does not run Antigravity again until the quota resets", () => {
    tick();
    tick();
    tick();

    expect(agyRuns()).toBe(1);
    expect(dispatchLog()).toMatch(/quota exhausted until/i);
  });

  it("runs again once the recorded reset time has passed", () => {
    writeFileSync(quotaFile(), `${Math.floor(Date.now() / 1000) - 60}\n`);

    tick();

    expect(agyRuns()).toBe(1);
    expect(existsSync(quotaFile())).toBe(true); // re-written by this run's own quota hit
  });

  it("an ordinary failure still marks the issue agent:failed", () => {
    tick("Error: something else broke");

    expect(ghLog()).toMatch(/--add-label agent:failed/);
    expect(existsSync(quotaFile())).toBe(false);
  });
});
