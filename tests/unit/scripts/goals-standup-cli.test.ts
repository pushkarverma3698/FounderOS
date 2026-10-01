/**
 * `pnpm goals:standup` — the hand-run entry to the SAME function the cron runs. `--now` runs it (and is as
 * idempotent as the cron: run it twice and it sends once), `--dry-run` renders without claiming or sending,
 * and anything else is a usage error rather than a guess.
 */

import { describe, it, expect, vi } from "vitest";
import { runGoalsStandupCli } from "../../../scripts/goals-standup.js";
import { CLAIM_LEASE_MS, type OutgoingMessage, type StandupDeps } from "../../../src/goals/standup.js";
import { InMemoryGoalRepo } from "../../helpers/fake-goal-repo.js";
import { newGoal } from "../../helpers/goal-repo-contract.js";
import { NINE_AM, TZ, makeMetricDeps } from "../../helpers/goal-fixtures.js";

async function setup(over: Partial<StandupDeps> = {}) {
  const repo = new InMemoryGoalRepo();
  const sent: OutgoingMessage[] = [];
  const lines: string[] = [];
  const skipped: string[] = [];
  const deps: StandupDeps = {
    repo,
    metrics: makeMetricDeps(),
    send: async (m) => void sent.push(m),
    readHalt: async () => null,
    skips: { record: async (d) => void skipped.push(d), take: async () => [] },
    now: () => NINE_AM,
    timeZone: TZ,
    tenant: "t",
    leaseMs: CLAIM_LEASE_MS,
    metricTimeoutMs: 100,
    sendTimeoutMs: 100,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  await repo.addGoal("t", newGoal({ title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", due_on: "2026-10-31" }), new Date("2026-09-01T08:00:00Z"));
  const run = (argv: string[]) => runGoalsStandupCli(argv, async () => deps, (line) => void lines.push(line));
  return { run, sent, lines, repo, skipped, deps };
}

describe("goals:standup --now", () => {
  it("runs the standup and says what it sent", async () => {
    const t = await setup();
    expect(await t.run(["--now"])).toBe(0);
    expect(t.sent).toHaveLength(1);
    expect(t.lines.join("\n")).toMatch(/sent 1 message covering 1 goal/);
  });

  it("is as idempotent as the cron: a second run sends nothing and says why", async () => {
    const t = await setup();
    await t.run(["--now"]);
    t.lines.length = 0;
    expect(await t.run(["--now"])).toBe(0);
    expect(t.sent).toHaveLength(1);
    expect(t.lines.join("\n")).toMatch(/already delivered/);
  });

  it("names a failed send and exits non-zero so a shell or a workflow notices", async () => {
    const t = await setup({ send: async () => { throw new Error("Bad Gateway"); } });
    expect(await t.run(["--now"])).toBe(1);
    expect(t.lines.join("\n")).toMatch(/NOT sent.*Bad Gateway/);
  });

  it("says another run holds the day when a live claim exists, with how long, and exits non-zero", async () => {
    const t = await setup();
    const [goal] = await t.repo.listOpenGoals("t");
    await t.repo.claimReviews("t", [goal!.id], "2026-09-29", NINE_AM, CLAIM_LEASE_MS);
    expect(await t.run(["--now"])).toBe(1);
    expect(t.lines.join("\n")).toMatch(/another run holds today's standup.*claim expires in \d+s/);
    expect(t.sent).toEqual([]);
  });

  it("reports a halt as skipped, not as an error", async () => {
    const t = await setup({ readHalt: async () => ({ reason: "x" }) });
    expect(await t.run(["--now"])).toBe(0);
    expect(t.lines.join("\n")).toMatch(/halted.*skipped/);
    expect(t.skipped).toEqual(["2026-09-29"]);
    expect(t.sent).toEqual([]);
  });

  it("says there is nothing to send when there are no goals, and sends nothing", async () => {
    const t = await setup();
    const [goal] = await t.repo.listOpenGoals("t");
    await t.repo.updateStatus("t", goal!.id, { status: "dropped" }, NINE_AM);
    expect(await t.run(["--now"])).toBe(0);
    expect(t.sent).toEqual([]);
    expect(t.lines.join("\n")).toMatch(/no open goals/);
  });
});

describe("goals:standup --dry-run", () => {
  it("prints exactly what would be sent, and claims, stores and sends nothing", async () => {
    const t = await setup();
    expect(await t.run(["--dry-run"])).toBe(0);
    const printed = t.lines.join("\n");
    expect(printed).toContain("Tashi applies: 0 of 5");
    expect(printed).toContain("Plan next step · 1");
    expect(t.sent).toEqual([]);
    expect(t.repo.reviews.size).toBe(0);
    for (const write of ["claimReviews", "saveReviewResults", "finalizeReviews"] as const) expect(t.repo.calls).not.toContain(write);
  });
});

describe("usage", () => {
  it("refuses to run with no flag, or two, or an unknown one, and exits 2 without touching anything", async () => {
    const t = await setup();
    const callsBefore = [...t.repo.calls];
    for (const argv of [[], ["--now", "--dry-run"], ["--tomorrow"], ["now"]]) {
      t.lines.length = 0;
      expect(await t.run(argv), JSON.stringify(argv)).toBe(2);
      expect(t.lines.join("\n")).toMatch(/Usage: pnpm goals:standup/);
    }
    expect(t.sent).toEqual([]);
    expect(t.repo.calls).toEqual(callsBefore);
  });
});
