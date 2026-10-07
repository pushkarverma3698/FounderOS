/**
 * pr-brain kill switch (~/.claude/pr-brain.off, set by Telegram /review off) stops the SWEEP, not an explicit --pr.
 *
 * 2026-10-07: with /review off, a /task built its PR and deploy/job-run then called `pr-brain --pr N`; the switch made
 * pr-brain exit 0 without a review and the job reported "the review was skipped". The sweep lock is held by hand here
 * so a run that gets past the switch stops at the lock (exit 75) instead of reviewing anything or touching the network.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));

let home: string;
let repo: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pr-brain-off-"));
  mkdirSync(join(home, ".claude", "pr-brain.lock"), { recursive: true });
  writeFileSync(join(home, ".claude", "pr-brain.off"), "switched off from Telegram /review\n");
  repo = join(home, "repo");
  mkdirSync(repo);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync("bash", [SCRIPT, "--repo", repo, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PR_BRAIN_LOCK_POLL_SEC: "1" },
    timeout: 30_000,
  });

describe("pr-brain kill switch", () => {
  it("a sweep with the switch on dispatches nothing and exits 0", () => {
    const r = run();

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kill switch present .* nothing dispatched/);
    expect(r.stdout).not.toMatch(/ignored for the explicit --pr/);
  });

  it("an explicit --pr gets past the switch (it stops at the held sweep lock, exit 75)", () => {
    const r = run("--pr", "7", "--wait-lock", "2");

    expect(r.stdout).toMatch(/kill switch present .* ignored for the explicit --pr 7/);
    expect(r.stdout).not.toMatch(/nothing dispatched/);
    expect(r.status).toBe(75);
  });
});
