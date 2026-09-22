/**
 * Unit test — every repo the founder can dispatch TO is a repo the dispatcher
 * actually sweeps.
 *
 * WHY THIS EXISTS. `DISPATCH_REPO_ALLOWLIST` (src/tools/dispatch-repos.ts) decides
 * what `/task repo:<hint>` accepts. `DEFAULT_REPOS` (deploy/agent-dispatch) decides
 * what the VPS daemon looks in. Nothing connected them, and on 2026-09-23 they
 * disagreed: `pushkarverma3698/House-of-Hulda-Website-frontend` was allowlisted and
 * named as an EXAMPLE in /task's usage text, while the dispatcher had never heard
 * of it. The founder's experience of that would have been: approve the card, watch
 * the issue get filed, and then nothing, forever — no error, no timeout, no
 * message. The loop's most expensive failure shape.
 *
 * This is the mechanism half of a rule that was previously only a comment. Adding
 * a repository to the allowlist now FAILS here until the daemon is taught about it,
 * which is the moment to also provision its review checkout, its agy workspace and
 * its six agent:* labels.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DISPATCH_REPO_ALLOWLIST } from "../../../src/tools/dispatch-repos.js";

/** The daemon's own default list, read from the script the VPS runs. */
function dispatcherDefaultRepos(): string[] {
  const source = readFileSync("deploy/agent-dispatch", "utf-8");
  const line = /^DEFAULT_REPOS=\((.*)\)$/m.exec(source);
  if (!line?.[1]) throw new Error("deploy/agent-dispatch no longer declares DEFAULT_REPOS=( … )");
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("dispatch allowlist ⊆ dispatcher sweep list", () => {
  it("leaves no allowlisted repository the dispatcher would never claim an issue from", () => {
    const serviced = dispatcherDefaultRepos().map((r) => r.toLowerCase());
    const stranded = DISPATCH_REPO_ALLOWLIST.filter((r) => !serviced.includes(r.toLowerCase()));

    expect(
      stranded,
      `${stranded.join(", ")} can be named in /task but deploy/agent-dispatch never sweeps it. ` +
        "An issue filed there sits at agent:ready forever and the founder is told nothing. " +
        "Add it to DEFAULT_REPOS — and provision its /opt/review checkout, its " +
        "/opt/agy-workspace clone and its agent:* labels on the VPS at the same time.",
    ).toEqual([]);
  });

  it("reads a non-empty list, so a renamed variable cannot make this test vacuous", () => {
    // A regex that stops matching would otherwise turn this into a check that
    // always passes — the shape of gate this repo has been burned by before.
    expect(dispatcherDefaultRepos().length).toBeGreaterThan(0);
  });
});
