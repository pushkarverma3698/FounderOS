import { describe, expect, it } from "vitest";
import { judgeWhere, parseWhereReply } from "../../../scripts/lib/journey-where.js";

const REPLY = "pushkarverma3698/FounderOS\nDone (7d): 12\n  • #813 /where\nIn flight: 2 open PRs, 1 agent issues\nLeft: 9 open issues (P1 2, none 7)\nBlocked: 0 issues, 1 PRs with failing checks";
const gh = (n: number) => ({ done: n + 11, openPrs: n + 1, left: n + 8 });

describe("parseWhereReply", () => {
  it("reads the three counts", () => {
    expect(parseWhereReply(REPLY)).toEqual({ done: 12, openPrs: 2, left: 9 });
  });
  it("returns undefined when a line is missing", () => {
    expect(parseWhereReply("Could not read\n• x: boom")).toBeUndefined();
  });
});

describe("judgeWhere (golden journey B)", () => {
  it("passes when every number matches GitHub", () => {
    expect(judgeWhere({ done: 12, openPrs: 2, left: 9 }, gh(1), gh(1)).ok).toBe(true);
  });
  it("passes when GitHub moved between the two reads and the reply sits between them", () => {
    expect(judgeWhere({ done: 12, openPrs: 2, left: 9 }, gh(1), { done: 12, openPrs: 3, left: 9 }).ok).toBe(true);
  });
  it("fails and names the field that disagrees", () => {
    const r = judgeWhere({ done: 12, openPrs: 2, left: 30 }, gh(1), gh(1));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("left: bot says 30, GitHub says 9");
  });
  it("fails when the reply could not be parsed", () => {
    expect(judgeWhere(undefined, gh(1), gh(1)).ok).toBe(false);
  });
});
