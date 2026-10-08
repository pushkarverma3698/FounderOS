/**
 * Unit test — the repos the founder can dispatch TO are exactly the repos the dispatcher sweeps, because they are
 * one list.
 *
 * WHY THIS EXISTS. `DISPATCH_REPO_ALLOWLIST` (src/tools/dispatch-repos.ts) decides what `/task repo:<hint>`
 * accepts. The VPS daemon used to carry its own copy (`DEFAULT_REPOS` in deploy/agent-dispatch), and on 2026-09-23
 * the two disagreed: a repo was allowlisted, the founder approved the card, the issue was filed and nothing ever
 * claimed it. A CI test held the two equal. There is no second copy now: the daemon asks the allowlist through
 * scripts/print-dispatch-repos.ts (deploy/lib/dispatch-repos.sh). What is left to pin is that the printer says what
 * the allowlist says, that no list reappears in the daemons, and that the list is sane.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DISPATCH_REPO_ALLOWLIST } from "../../../src/tools/dispatch-repos.js";

/** GitHub slugs are case-insensitive. */
const duplicates = (repos: readonly string[]): string[] => {
  const seen = new Set<string>();
  return repos.map((r) => r.toLowerCase()).filter((r) => (seen.has(r) ? true : (seen.add(r), false)));
};

describe("the dispatch repo list is one list", () => {
  it("the printer the daemons run prints exactly DISPATCH_REPO_ALLOWLIST, in order", () => {
    const r = spawnSync("node", ["--import", "tsx/esm", "scripts/print-dispatch-repos.ts"], { encoding: "utf8", timeout: 60_000 });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([...DISPATCH_REPO_ALLOWLIST]);
  });

  it("neither bash daemon declares a list of its own", () => {
    for (const file of ["deploy/agent-dispatch", "deploy/onboard-repo.sh"]) {
      expect(readFileSync(file, "utf8"), `${file} must ask dispatch_repos_print, not carry a copy`).not.toMatch(/^[A-Z_]*REPOS=\(\s*"/m);
    }
  });

  it("lists each repository once: a duplicate would be swept and claimed twice", () => {
    expect(duplicates(DISPATCH_REPO_ALLOWLIST), "DISPATCH_REPO_ALLOWLIST lists a repo twice").toEqual([]);
  });

  it("is not empty, so a daemon that reads it never sweeps nothing", () => {
    expect(DISPATCH_REPO_ALLOWLIST.length).toBeGreaterThan(0);
  });
});
