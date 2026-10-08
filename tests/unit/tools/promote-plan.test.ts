/**
 * Unit tests for the pure parts of /promote (src/tools/promote-plan.ts): what a compare result says is on beta,
 * the card text, and the request line that goes to the job socket.
 */

import { describe, it, expect } from "vitest";
import { PROMOTE_REPO, planFromCompare, promoteCardText, promoteRequestLine, validatePromoteRequest } from "../../../src/tools/promote-plan.js";

const SHA = "a".repeat(40);

const merge = (n: number, title: string) => ({ commit: { message: `Merge pull request #${n} from o/branch-${n}\n\n${title}` } });
const squash = (n: number, title: string) => ({ commit: { message: `${title} (#${n})\n\nbody` } });
const bare = (msg: string) => ({ commit: { message: msg } });
const compare = (commits: unknown[], files = 3, extra: Record<string, unknown> = {}) => ({
  status: "ahead",
  ahead_by: commits.length,
  commits,
  files: Array.from({ length: files }, (_, i) => ({ filename: `f${i}.ts` })),
  ...extra,
});

describe("planFromCompare", () => {
  it("lists each PR once, from merge commits and squash-tagged commits", () => {
    const plan = planFromCompare(compare([merge(11, "Fix the queue"), squash(12, "Add the card"), merge(11, "Fix the queue")]), SHA);
    expect(plan?.prs).toEqual([
      { number: 11, title: "Fix the queue" },
      { number: 12, title: "Add the card" },
    ]);
    expect(plan?.betaSha).toBe(SHA);
    expect(plan?.files).toBe(3);
  });

  it("is null when beta is not ahead of main", () => {
    expect(planFromCompare({ status: "identical", ahead_by: 0, commits: [], files: [] }, SHA)).toBeNull();
    expect(planFromCompare({ status: "behind", ahead_by: 0, commits: [], files: [] }, SHA)).toBeNull();
  });

  it("is null when beta is ahead only by commits that change no file", () => {
    expect(planFromCompare(compare([bare("Merge branch 'main' into beta")], 0), SHA)).toBeNull();
  });

  it("counts commits with no PR number but does not invent PRs for them", () => {
    const plan = planFromCompare(compare([bare("direct commit"), bare("another one")]), SHA);
    expect(plan?.prs).toEqual([]);
    expect(plan?.aheadBy).toBe(2);
  });

  it("is null for anything that is not a compare result", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { commits: [] }, { files: [] }]) {
      expect(planFromCompare(bad, SHA)).toBeNull();
    }
  });
});

describe("promoteCardText", () => {
  it("names the PRs and the commit, plural", () => {
    const plan = planFromCompare(compare([merge(11, "Fix the queue"), squash(12, "Add the card")]), SHA)!;
    const text = promoteCardText(plan);
    expect(text.split("\n")[0]).toBe("Promote 2 PRs to prod?");
    expect(text).toContain("#11 Fix the queue");
    expect(text).toContain("#12 Add the card");
    expect(text).toContain("beta aaaaaaa into main (3 files)");
  });

  it("uses the singular for one PR and one file", () => {
    const plan = planFromCompare(compare([merge(7, "One thing")], 1), SHA)!;
    expect(promoteCardText(plan).split("\n")[0]).toBe("Promote 1 PR to prod?");
    expect(promoteCardText(plan)).toContain("(1 file)");
  });

  it("stays under the Telegram limit for a long list and says how many it left out", () => {
    const commits = Array.from({ length: 200 }, (_, i) => merge(i + 1, "x".repeat(200)));
    const text = promoteCardText(planFromCompare(compare(commits), SHA)!);
    expect(text.length).toBeLessThan(3900);
    expect(text).toContain("… and 185 more");
  });

  it("says so when the commits carry no PR number", () => {
    const text = promoteCardText(planFromCompare(compare([bare("direct commit")]), SHA)!);
    expect(text.split("\n")[0]).toBe("Promote beta to prod?");
    expect(text).toContain("1 commit with no PR number");
  });
});

describe("promote request", () => {
  it("is one JSON line with the stage, the repo and the commit the founder saw", () => {
    const line = promoteRequestLine(` ${PROMOTE_REPO} `, SHA);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ repo: PROMOTE_REPO, stage: "promote", beta_sha: SHA });
  });

  it("refuses another repo, a malformed repo and a sha that is not 40 hex", () => {
    expect(validatePromoteRequest("pushkarverma3698/Oplify", SHA)).toContain("only wired for");
    expect(validatePromoteRequest("o/r;touch x", SHA)).toContain("invalid repo");
    expect(validatePromoteRequest(PROMOTE_REPO, "abc123")).toContain("40 hex");
    expect(validatePromoteRequest(PROMOTE_REPO, `${"a".repeat(39)};`)).toContain("40 hex");
    expect(validatePromoteRequest(PROMOTE_REPO, SHA)).toBeNull();
    expect(() => promoteRequestLine(PROMOTE_REPO, "nope")).toThrow("40 hex");
  });
});
