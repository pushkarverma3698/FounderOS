/**
 * Unit test — the repos the founder can dispatch TO are exactly the repos the dispatcher sweeps.
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
 * its six agent:* labels (`pnpm repo:add <owner/repo>` does the file edits and prints
 * the VPS command).
 *
 * It used to check only that the allowlist was a SUBSET of the sweep list. It is now
 * EQUALITY, so the opposite drift fails too: a repo the daemon sweeps that the founder
 * cannot dispatch to is an unreviewed write target that was never approved as one.
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

/** Order is not part of the contract; membership and multiplicity are. GitHub slugs are case-insensitive. */
const normalised = (repos: readonly string[]): string[] => repos.map((r) => r.toLowerCase()).sort();

const duplicates = (repos: readonly string[]): string[] => {
  const seen = new Set<string>();
  return normalised(repos).filter((r) => (seen.has(r) ? true : (seen.add(r), false)));
};

describe("dispatch allowlist = dispatcher sweep list", () => {
  it("is the same set in both places: nothing dispatchable is unswept, and nothing swept is undispatchable", () => {
    const sweptRepos = dispatcherDefaultRepos();
    const allowed = normalised(DISPATCH_REPO_ALLOWLIST);
    const swept = normalised(sweptRepos);
    // Compared lower-cased, printed as written, so the message names the repo the way a human typed it.
    const asWritten = new Map([...DISPATCH_REPO_ALLOWLIST, ...sweptRepos].map((r) => [r.toLowerCase(), r]));
    const stranded = allowed.filter((r) => !swept.includes(r)).map((r) => asWritten.get(r) ?? r);
    const unapproved = swept.filter((r) => !allowed.includes(r)).map((r) => asWritten.get(r) ?? r);

    // Each reason is printed with its own result, so a failure says which side to fix.
    const reasons = [
      stranded.length > 0
        ? `${stranded.join(", ")} can be named in /task but deploy/agent-dispatch never sweeps it. ` +
          "An issue filed there sits at agent:ready forever and the founder is told nothing. " +
          "Add it to DEFAULT_REPOS — and provision its /opt/review checkout, its " +
          "/opt/agy-workspace clone and its agent:* labels on the VPS at the same time " +
          "(pnpm repo:add does the edits and prints the command)."
        : null,
      unapproved.length > 0
        ? `${unapproved.join(", ")} is swept by deploy/agent-dispatch but is not in DISPATCH_REPO_ALLOWLIST. ` +
          "The daemon would claim and write to a repository the founder never approved as a target. " +
          "Remove it from DEFAULT_REPOS, or add it to src/tools/dispatch-repos.ts through a reviewed PR."
        : null,
    ].filter((reason): reason is string => reason !== null);

    expect({ stranded, unapproved }, reasons.join("\n")).toEqual({ stranded: [], unapproved: [] });
    expect(swept).toEqual(allowed);
  });

  it("lists each repository once in each list: a duplicate would be swept and claimed twice", () => {
    expect(duplicates(DISPATCH_REPO_ALLOWLIST), "DISPATCH_REPO_ALLOWLIST lists a repo twice").toEqual([]);
    expect(duplicates(dispatcherDefaultRepos()), "DEFAULT_REPOS in deploy/agent-dispatch lists a repo twice").toEqual([]);
  });

  it("reads a non-empty list, so a renamed variable cannot make this test vacuous", () => {
    // A regex that stops matching would otherwise turn this into a check that
    // always passes — the shape of gate this repo has been burned by before.
    expect(dispatcherDefaultRepos().length).toBeGreaterThan(0);
  });
});
