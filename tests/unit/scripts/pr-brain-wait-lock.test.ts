/**
 * pr-brain --wait-lock — a job (deploy/job-run) reviews ONE PR and waits for a running sweep instead of skipping.
 *
 * Without it a /task finished at a quarter past the hour met the 20-minute sweep's lock, pr-brain logged "this tick
 * does nothing" and exited 0, and the job reported "review skipped": a false failure on a healthy pipeline.
 * The lock is held by hand here, so nothing is reviewed and nothing touches the network.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));

let home: string;
let repo: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pr-brain-lock-"));
  mkdirSync(join(home, ".claude", "pr-brain.lock"), { recursive: true });
  repo = join(home, "repo");
  mkdirSync(repo);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync("bash", [SCRIPT, "--repo", repo, "--pr", "1", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PR_BRAIN_LOCK_POLL_SEC: "1" },
    timeout: 30_000,
  });

describe("pr-brain --wait-lock", () => {
  it("without it a held sweep lock still skips quietly with exit 0 (the cron path is unchanged)", () => {
    const r = run();

    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/gave up/);
  });

  it("with it the run says it is queued, waits, then gives up LOUDLY with exit 75 and leaves the other sweep's lock alone", () => {
    const r = run("--wait-lock", "2");

    expect(r.status).toBe(75);
    expect(r.stderr).toMatch(/gave up waiting 2s for the sweep lock/);
  });

  it("rejects a non-numeric wait", () => {
    const r = run("--wait-lock", "soon");

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--wait-lock takes a number of seconds/);
  });
});
