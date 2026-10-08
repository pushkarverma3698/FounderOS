/**
 * Deployed-version fact: "what is live?" has an answer.
 * =====================================================
 * Prod 2026-10-07: the founder asked what shipped today and the bot said no deployment was confirmed, although prod had
 * moved an hour earlier, because nothing in src/ knew which commit the process was running. The commit is read once, at
 * boot, through an injected git runner, and reported as one line in the ops_state `background_jobs` scope.
 *
 * Pinned here: the line's exact shape, that every failure is "unknown" and never a throw, and that the format string works
 * against real git (a temp repo with a fixed date), since a fake runner cannot prove that.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDeployedLine, deployedLine, gitRunner, readDeployedCommit, type GitRunner } from "../../../src/infra/deployed-version.js";

const US = "\u001f";
const SHA = "fec30752a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** 2026-10-07 08:42:00 UTC. */
const EPOCH = Date.UTC(2026, 9, 7, 8, 42, 0) / 1000;
const out = (sha: string, epoch: string, subject: string): string => `${sha}${US}${epoch}${US}${subject}\n`;
const fakeGit = (text: string): GitRunner => () => text;
const failing = (message: string): GitRunner => () => {
  throw new Error(message);
};

describe("readDeployedCommit", () => {
  it("reads the short sha, the commit time and the subject, in one git call", () => {
    const calls: (readonly string[])[] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      return out(SHA, String(EPOCH), "fix(pr-brain): an explicit --pr ignores the sweep's kill switch (#996)");
    };
    const commit = readDeployedCommit(run);
    expect(commit).toEqual({
      sha: "fec3075",
      committedAt: new Date(EPOCH * 1000),
      subject: "fix(pr-brain): an explicit --pr ignores the sweep's kill switch (#996)",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["log", "-1"]);
  });

  it("keeps a unit separator inside the subject", () => {
    expect(readDeployedCommit(fakeGit(out(SHA, String(EPOCH), `a${US}b`)))?.subject).toBe(`a${US}b`);
  });

  it.each([
    ["git exits non-zero (not a repository)", failing("fatal: not a git repository")],
    ["git is not installed", failing("spawnSync git ENOENT")],
    ["git times out", failing("spawnSync git ETIMEDOUT")],
    ["empty output", fakeGit("")],
    ["only a sha", fakeGit(`${SHA}\n`)],
    ["a time that is not a number", fakeGit(out(SHA, "yesterday", "subject"))],
    ["an empty sha", fakeGit(out("", String(EPOCH), "subject"))],
    ["a sha that is not hex", fakeGit(out("fatal: bad object", String(EPOCH), "subject"))],
  ])("%s -> null, never a throw", (_label, run) => {
    expect(readDeployedCommit(run)).toBeNull();
  });
});

describe("deployedLine", () => {
  const started = new Date("2026-10-07T09:50:00Z");
  const commit = { sha: "fec3075", committedAt: new Date(EPOCH * 1000), subject: "fix(pr-brain): kill switch (#996)" };

  it("is `Deployed: <sha7> \"<subject>\" (<committed date>), process started <time>`", () => {
    expect(deployedLine(commit, started)).toBe(
      'Deployed: fec3075 "fix(pr-brain): kill switch (#996)" (2026-10-07 08:42 UTC), process started 2026-10-07 09:50 UTC',
    );
  });

  it("says unknown, with the start time, when the commit could not be read", () => {
    expect(deployedLine(null, started)).toBe("Deployed: unknown, process started 2026-10-07 09:50 UTC");
  });

  it("keeps the line one line: quotes become apostrophes, newlines collapse, a long subject is cut", () => {
    const line = deployedLine({ ...commit, subject: `say "hi"\nthen   go ${"x".repeat(200)}` }, started);
    expect(line).not.toContain("\n");
    expect(line).toContain(`"say 'hi' then go `);
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(260);
  });
});

describe("bootDeployedLine", () => {
  it("derives the start time from the clock and the uptime, both injected", () => {
    const now = Date.UTC(2026, 9, 7, 10, 0, 0);
    const line = bootDeployedLine(fakeGit(out(SHA, String(EPOCH), "subject")), now, 600);
    expect(line).toBe('Deployed: fec3075 "subject" (2026-10-07 08:42 UTC), process started 2026-10-07 09:50 UTC');
  });

  it("a failing runner gives the unknown line, not an exception", () => {
    const now = Date.UTC(2026, 9, 7, 10, 0, 0);
    expect(bootDeployedLine(failing("boom"), now, 0)).toBe("Deployed: unknown, process started 2026-10-07 10:00 UTC");
  });
});

describe("gitRunner against real git", () => {
  const runGit = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdio: "ignore",
      env: { ...process.env, GIT_COMMITTER_DATE: "2026-10-07T08:42:00Z", GIT_AUTHOR_DATE: "2026-10-07T08:42:00Z" },
    });
  };

  it("reads HEAD of the repository in the given directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "deployed-version-"));
    try {
      runGit(dir, "init", "--quiet");
      writeFileSync(join(dir, "a.txt"), "a");
      runGit(dir, "add", "a.txt");
      runGit(dir, "commit", "--quiet", "-m", 'feat: ship it, "quoted"');
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

      const commit = readDeployedCommit(gitRunner(dir));
      expect(commit).toEqual({ sha: sha.slice(0, 7), committedAt: new Date("2026-10-07T08:42:00Z"), subject: 'feat: ship it, "quoted"' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a directory that is not a repository is unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "deployed-version-none-"));
    try {
      expect(readDeployedCommit(gitRunner(dir))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
