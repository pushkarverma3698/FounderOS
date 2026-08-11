/**
 * Sync-beta workflow contract — .github/workflows/sync-beta.yml.
 * ================================================================
 * beta is a protected branch (required PR, 2 required status checks,
 * enforce_admins on). The workflow originally ran `git push origin beta`, which
 * the protection rejects with GH006 — so it failed on EVERY run, beta froze 125
 * commits behind main, and the work → beta → main ladder stopped running while
 * CI reported nothing but a red check nobody read.
 *
 * These pin the properties that made it fail. A future edit that reintroduces a
 * direct push to a protected branch breaks here instead of in CI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = readFileSync(fileURLToPath(new URL("../../../.github/workflows/sync-beta.yml", import.meta.url)), "utf8");

describe("sync-beta workflow", () => {
  it("never pushes directly to the protected beta branch", () => {
    const pushes = WORKFLOW.split("\n").filter((line) => /^\s*git\s+push\b/.test(line));
    expect(pushes, `beta rejects direct pushes (GH006); use a PR instead. Found: ${pushes.join(" | ")}`).toEqual([]);
  });

  it("syncs through a pull request, the mechanism the protection requires", () => {
    expect(WORKFLOW).toMatch(/gh pr create/);
    expect(WORKFLOW).toMatch(/--base beta/);
    expect(WORKFLOW).toMatch(/--head main/);
  });

  it("declares the pull-request write permission the PR path needs", () => {
    expect(WORKFLOW).toMatch(/pull-requests:\s*write/);
  });

  it("skips when beta already contains main, and never opens a duplicate PR", () => {
    expect(WORKFLOW).toMatch(/merge-base --is-ancestor origin\/main origin\/beta/);
    expect(WORKFLOW).toMatch(/gh pr list --base beta --head main --state open/);
  });
});
