/**
 * The /goal command grammar, pure. The rule these tests hold: a missing or invalid field is NAMED,
 * with what to write instead — and nothing is ever guessed. Fix the schema, not the code.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_PRIORITY,
  MAX_REASON_CHARS,
  MAX_TITLE_CHARS,
  goalArgsOf,
  parseGoalCommand,
  type ParseContext,
  type ParseIssue,
} from "../../../src/goals/parse.js";
import { MAX_GOAL_VALUE } from "../../../src/goals/numeric.js";

const PROFILES = ["pushkar-nl-tech", "wife-nl-finance"];
const CTX: ParseContext = {
  today: "2026-09-29",
  resolveProfile: (token) => {
    const t = token.toLowerCase();
    if (PROFILES.includes(t)) return t;
    return t === "tashi" ? "wife-nl-finance" : null;
  },
};

const parse = (raw: string, ctx: ParseContext = CTX) => parseGoalCommand(raw, ctx);

function issuesOf(raw: string, ctx: ParseContext = CTX): readonly ParseIssue[] {
  const out = parse(raw, ctx);
  expect(out.ok, `expected ${JSON.stringify(raw)} to be refused`).toBe(false);
  return out.ok ? [] : out.issues;
}

const fields = (raw: string, ctx?: ParseContext): string[] => issuesOf(raw, ctx).map((i) => i.field);

describe("/goal — no arguments", () => {
  it("shows usage rather than an error", () => {
    expect(parse("")).toEqual({ ok: true, command: { kind: "usage" } });
    expect(parse("   ")).toEqual({ ok: true, command: { kind: "usage" } });
  });
});

describe("/goal add — the happy path", () => {
  it("parses the plan's own example", () => {
    const out = parse("add Tashi applies to 5 NL roles a week | metric=applications_7d:wife-nl-finance target=5 by=2026-10-31");
    expect(out).toEqual({
      ok: true,
      command: {
        kind: "add",
        draft: {
          title: "Tashi applies to 5 NL roles a week",
          metricKey: "applications_7d",
          metricArg: "wife-nl-finance",
          target: 5,
          baseline: 0,
          dueOn: "2026-10-31",
          priority: 100,
        },
      },
    });
  });

  it("takes options in any order, with optional baseline and priority, and no due date", () => {
    const out = parse("add Reach 5k MRR | target=5000 baseline=1200 priority=10 metric=manual");
    expect(out).toMatchObject({
      ok: true,
      command: {
        kind: "add",
        draft: { title: "Reach 5k MRR", metricKey: "manual", metricArg: null, target: 5000, baseline: 1200, dueOn: null, priority: 10 },
      },
    });
  });

  it("resolves a friendly profile word to the profile id, so `tashi` works like it does on /jobs", () => {
    const out = parse("add x | metric=applications_7d:tashi target=5");
    expect(out).toMatchObject({ ok: true, command: { draft: { metricArg: "wife-nl-finance" } } });
  });

  it("lets a title contain a pipe: the options start after the LAST one", () => {
    const out = parse("add Ship | review | metric=manual target=3");
    expect(out).toMatchObject({ ok: true, command: { draft: { title: "Ship | review" } } });
  });

  it("accepts a fractional target and a due date of today", () => {
    expect(parse("add x | metric=manual target=2.5 by=2026-09-29")).toMatchObject({
      ok: true,
      command: { draft: { target: 2.5, dueOn: "2026-09-29" } },
    });
  });

  it("accepts tabs and newlines between options, as a phone keyboard can produce them", () => {
    expect(parse("add x |\nmetric=manual\ttarget=3")).toMatchObject({ ok: true, command: { draft: { target: 3 } } });
  });
});

describe("/goal add — every problem is named, and finite choices are offered", () => {
  it("names a missing separator with an example, and does not pretend to know the other fields", () => {
    const issues = issuesOf("add Ship a fix metric=manual target=1");
    expect(issues.map((i) => i.field)).toEqual(["separator"]);
    expect(issues[0]!.message).toContain("|");
  });

  it("names a missing title", () => {
    expect(fields("add | metric=manual target=1")).toEqual(["title"]);
    expect(fields("add    | metric=manual target=1")).toEqual(["title"]);
  });

  it("names a title over the limit, with its length", () => {
    const issues = issuesOf(`add ${"x".repeat(MAX_TITLE_CHARS + 1)} | metric=manual target=1`);
    expect(issues[0]!.field).toBe("title");
    expect(issues[0]!.message).toContain(String(MAX_TITLE_CHARS + 1));
  });

  it("asks for a missing metric and offers the five keys as buttons", () => {
    const issues = issuesOf("add Ship a fix | target=1");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("metric");
    expect(issues[0]!.choices).toEqual({ kind: "metric-family" });
  });

  it("rejects an unknown metric key, lists the valid ones, and offers the buttons", () => {
    const issues = issuesOf("add x | metric=revenue_7d target=1");
    expect(issues[0]!.message).toMatch(/revenue_7d.*applications_7d.*manual/s);
    expect(issues[0]!.choices).toEqual({ kind: "metric-family" });
  });

  it("asks for the argument a key needs, and offers profiles or repos as the choice", () => {
    expect(issuesOf("add x | metric=applications_7d target=5")[0]).toMatchObject({
      field: "metric",
      choices: { kind: "metric-arg", family: "applications_7d" },
    });
    expect(issuesOf("add x | metric=prs_merged_7d target=5")[0]).toMatchObject({
      choices: { kind: "metric-arg", family: "prs_merged_7d" },
    });
  });

  it("does not guess an unknown profile: it names it and offers the real ones", () => {
    const [issue] = issuesOf("add x | metric=applications_7d:nobody target=5");
    expect(issue!.message).toContain("nobody");
    expect(issue!.choices).toEqual({ kind: "metric-arg", family: "applications_7d" });
  });

  it("refuses a repo that is not owner/repo", () => {
    for (const bad of ["acme", "acme/api/extra", "acme/api;x", "/api"]) {
      const [issue] = issuesOf(`add x | metric=prs_merged_7d:${bad} target=1`);
      expect(issue!.field, bad).toBe("metric");
    }
  });

  it("gives action_count_7d no buttons (the action names are not a finite list) but still says what to write", () => {
    const [issue] = issuesOf("add x | metric=action_count_7d target=3");
    expect(issue!.choices).toBeUndefined();
    expect(issue!.message).toContain("action_count_7d:<action>");
  });

  it("refuses an argument on manual", () => {
    expect(issuesOf("add x | metric=manual:oops target=1")[0]!.message).toMatch(/takes no argument/);
  });

  it("names a missing target and a malformed one", () => {
    expect(fields("add x | metric=manual")).toEqual(["target"]);
    expect(issuesOf("add x | metric=manual target=abc")[0]!.message).toContain("abc");
    expect(issuesOf("add x | metric=manual target=1,000")[0]!.message).toMatch(/plain number/);
    expect(fields("add x | metric=manual target=")).toEqual(["target"]);
  });

  it("refuses a target of 0 or below: there is nothing to reach", () => {
    expect(issuesOf("add x | metric=manual target=0")[0]!.message).toMatch(/greater than 0/);
    expect(issuesOf("add x | metric=manual target=-3")[0]!.message).toMatch(/greater than 0/);
  });

  it("refuses a target too large to be a real goal, and accepts the largest allowed", () => {
    expect(fields(`add x | metric=manual target=${MAX_GOAL_VALUE * 10}`)).toEqual(["target"]);
    expect(parse(`add x | metric=manual target=${MAX_GOAL_VALUE}`).ok).toBe(true);
  });

  it("names a malformed, impossible or past due date", () => {
    expect(issuesOf("add x | metric=manual target=1 by=31/10/2026")[0]!.message).toMatch(/YYYY-MM-DD/);
    expect(issuesOf("add x | metric=manual target=1 by=2026-02-30")[0]!.field).toBe("by");
    const past = issuesOf("add x | metric=manual target=1 by=2026-09-28")[0]!;
    expect(past.field).toBe("by");
    expect(past.message).toMatch(/already in the past/);
    expect(past.message).toContain("2026-09-29");
  });

  it("names a bad baseline and a bad priority", () => {
    expect(fields("add x | metric=manual target=5 baseline=-1")).toEqual(["baseline"]);
    expect(fields("add x | metric=manual target=5 priority=0")).toEqual(["priority"]);
    expect(fields(`add x | metric=manual target=5 priority=${MAX_PRIORITY + 1}`)).toEqual(["priority"]);
    expect(fields("add x | metric=manual target=5 priority=1.5")).toEqual(["priority"]);
  });

  it("refuses an unknown option and a repeated one instead of ignoring them", () => {
    const unknown = issuesOf("add x | metric=manual target=5 colour=red");
    expect(unknown[0]!.field).toBe("colour");
    expect(unknown[0]!.message).toMatch(/metric, target, by, baseline, priority/);
    expect(issuesOf("add x | metric=manual metric=manual target=5")[0]!.message).toMatch(/twice/);
    expect(fields("add x | metric=manual target=5 stray")).toEqual(["stray"]);
  });

  it("reports every problem at once, in a fixed order, not one per attempt", () => {
    expect(fields("add | target=abc by=nope priority=0")).toEqual(["title", "metric", "target", "by", "priority"]);
  });

  it("lets a button supply the metric the founder left out (or got wrong)", () => {
    const withOverride: ParseContext = { ...CTX, metricOverride: "manual" };
    expect(parse("add Ship a fix | target=1", withOverride)).toMatchObject({ ok: true, command: { draft: { metricKey: "manual" } } });
    expect(parse("add x | metric=revenue_7d target=1", withOverride)).toMatchObject({ ok: true, command: { draft: { metricKey: "manual" } } });
  });
});

describe("/goal <n> <value> — report a manual value", () => {
  it("parses n and a value, including 0 and a fraction", () => {
    expect(parse("2 1200")).toEqual({ ok: true, command: { kind: "set-value", n: 2, value: 1200 } });
    expect(parse("1 0")).toEqual({ ok: true, command: { kind: "set-value", n: 1, value: 0 } });
    expect(parse("3 2.5")).toEqual({ ok: true, command: { kind: "set-value", n: 3, value: 2.5 } });
  });

  it("names a missing or malformed value", () => {
    expect(fields("2")).toEqual(["value"]);
    expect(issuesOf("2 lots")[0]!.message).toContain("lots");
    expect(fields("2 1,200")).toEqual(["value"]);
    expect(fields("2 1 2")).toEqual(["extra"]);
    expect(fields(`2 ${MAX_GOAL_VALUE * 10}`)).toEqual(["value"]);
  });

  it("names a goal number of 0", () => {
    expect(issuesOf("0 5")[0]!.message).toMatch(/start at 1/);
  });
});

describe("/goal done | drop | unblock <n>", () => {
  it("parses each with a goal number", () => {
    expect(parse("done 2")).toEqual({ ok: true, command: { kind: "done", n: 2 } });
    expect(parse("DROP 3")).toEqual({ ok: true, command: { kind: "drop", n: 3 } });
    expect(parse("unblock 1")).toEqual({ ok: true, command: { kind: "unblock", n: 1 } });
  });

  it("names a missing, malformed or zero goal number, and stray extras", () => {
    for (const verb of ["done", "drop", "unblock"]) {
      expect(fields(verb), verb).toEqual(["n"]);
      expect(fields(`${verb} two`), verb).toEqual(["n"]);
      expect(issuesOf(`${verb} 0`)[0]!.message).toMatch(/start at 1/);
      expect(fields(`${verb} 2 now`), verb).toEqual(["extra"]);
    }
  });
});

describe("/goal block <n> <reason> [until=YYYY-MM-DD]", () => {
  it("parses a reason, with and without a date", () => {
    expect(parse("block 2 waiting on the visa decision")).toEqual({
      ok: true,
      command: { kind: "block", n: 2, reason: "waiting on the visa decision", until: null },
    });
    expect(parse("block 2 waiting on the visa decision until=2026-10-15")).toEqual({
      ok: true,
      command: { kind: "block", n: 2, reason: "waiting on the visa decision", until: "2026-10-15" },
    });
  });

  it("accepts until= before the reason as well", () => {
    expect(parse("block 1 until=2026-10-15 landlord")).toMatchObject({ ok: true, command: { reason: "landlord", until: "2026-10-15" } });
  });

  it("names a missing reason", () => {
    expect(fields("block 2")).toEqual(["reason"]);
    expect(fields("block 2 until=2026-10-15")).toEqual(["reason"]);
  });

  it("names a missing goal number and a reason over the limit", () => {
    expect(fields("block")).toEqual(["n"]);
    expect(fields(`block 1 ${"y".repeat(MAX_REASON_CHARS + 1)}`)).toEqual(["reason"]);
  });

  it("names an until that is malformed, or not after today", () => {
    expect(issuesOf("block 1 x until=soon")[0]!.field).toBe("until");
    expect(issuesOf("block 1 x until=2026-09-29")[0]!.message).toMatch(/after today/);
    expect(issuesOf("block 1 x until=2026-09-01")[0]!.message).toMatch(/after today/);
  });
});

describe("unknown subcommands", () => {
  it("names the word it did not understand and lists what it does", () => {
    const [issue] = issuesOf("finish 2");
    expect(issue!.field).toBe("command");
    expect(issue!.message).toContain("finish");
    expect(issue!.message).toMatch(/add.*done.*drop.*block/s);
  });
});

describe("goalArgsOf — the arguments of a /goal message, read back from a message's text", () => {
  it("strips the command and an @botname", () => {
    expect(goalArgsOf("/goal add x | metric=manual target=1")).toBe("add x | metric=manual target=1");
    expect(goalArgsOf("/goal@founderos_bot add x")).toBe("add x");
    expect(goalArgsOf("  /goal   done 2 ")).toBe("done 2");
    expect(goalArgsOf("/goal")).toBe("");
  });

  it("extracts /goal command from confirmation cards and wrapped messages", () => {
    expect(goalArgsOf("Run this?\n/goal add Apply to 20 jobs | target=20")).toBe("add Apply to 20 jobs | target=20");
    expect(goalArgsOf("Run this?\n<code>/goal add Apply to 20 jobs | target=20</code>")).toBe("add Apply to 20 jobs | target=20");
    expect(goalArgsOf("❌ Not done. 1 thing to fix:\nCommand: <code>/goal add Ship a fix | target=1</code>")).toBe("add Ship a fix | target=1");
  });

  it("does not read other commands or plain text as a /goal message", () => {
    expect(goalArgsOf("/goals")).toBeNull();
    expect(goalArgsOf("/task fix it")).toBeNull();
    expect(goalArgsOf("goal add x")).toBeNull();
    expect(goalArgsOf("")).toBeNull();
  });
});

