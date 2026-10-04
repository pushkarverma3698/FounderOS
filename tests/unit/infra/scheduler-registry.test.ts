/**
 * The bot's built-in routines, as the founder is told about them (src/infra/scheduler-registry.ts).
 * ================================================================================================
 * A hand-kept list of what runs is the exact thing that drifted before (the hand-written department paragraph). Nothing
 * in scheduler.ts is rewritten to feed this registry, so the CI mechanism is this test: it reads the cron expressions
 * out of scheduler.ts and fails, naming the one that is missing, when a cron is added, changed or removed there
 * without the registry following.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEDULED_ROUTINES, describeCron } from "../../../src/infra/scheduler-registry.js";
import { FREE_SWEEP_CRON } from "../../../src/tools/jobhunt/sweep-runner.js";
import { STANDUP_CRON } from "../../../src/goals/standup-schedule.js";
import { JOBHUNT_FINDINGS_CRON } from "../../../src/evolution/jobhunt-findings-cron.js";

const SCHEDULER = readFileSync(fileURLToPath(new URL("../../../src/infra/scheduler.ts", import.meta.url)), "utf8");

/** Identifiers scheduler.ts passes to cron.schedule instead of a literal. */
const NAMED_CRONS: Record<string, string> = { FREE_SWEEP_CRON };

function cronsInScheduler(): string[] {
  const found: string[] = [];
  for (const m of SCHEDULER.matchAll(/cron\.schedule\(\s*(?:"([^"]+)"|([A-Z_]+))/g)) {
    if (m[1]) found.push(m[1]);
    else {
      const resolved = NAMED_CRONS[m[2] ?? ""];
      if (!resolved) throw new Error(`scheduler.ts schedules ${m[2]}: add it to NAMED_CRONS in this test so the registry can be checked against it`);
      found.push(resolved);
    }
  }
  return found.sort();
}

describe("scheduler registry", () => {
  it("lists exactly the crons scheduler.ts registers", () => {
    const registered = SCHEDULED_ROUTINES.filter((r) => r.source === "scheduler.ts").map((r) => r.cron).sort();
    expect(registered, "src/infra/scheduler.ts and src/infra/scheduler-registry.ts disagree: add or fix the registry entry").toEqual(cronsInScheduler());
  });

  it("the routines registered from other files use those files' own cron constants", () => {
    const own = (id: string) => SCHEDULED_ROUTINES.find((r) => r.id === id)?.cron;
    expect(own("goal-standup")).toBe(STANDUP_CRON);
    expect(own("jobhunt-findings")).toBe(JOBHUNT_FINDINGS_CRON);
    expect(own("free-board-sweep")).toBe(FREE_SWEEP_CRON);
  });

  it("scheduler.ts still starts the two routines that register themselves", () => {
    expect(SCHEDULER).toContain("scheduleGoalStandup(");
    expect(SCHEDULER).toContain("startJobhuntFindingsCron(");
  });

  it("every entry has a unique id and a plain sentence for the founder", () => {
    const ids = SCHEDULED_ROUTINES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SCHEDULED_ROUTINES) {
      expect(r.title.length, r.id).toBeGreaterThan(2);
      expect(r.what.length, r.id).toBeGreaterThan(10);
      expect(r.what, r.id).not.toMatch(/\b(cron|sweep|LLM|tick)\b/i);
    }
  });
});

describe("describeCron", () => {
  it.each([
    ["* * * * *", "every minute"],
    ["*/30 * * * *", "every 30 minutes"],
    ["0 * * * *", "every hour"],
    ["0 2 * * *", "daily at 02:00"],
    ["30 3 * * *", "daily at 03:30"],
    ["0 9 * * 1", "Mondays at 09:00"],
    ["0 10 1 * *", "on the 1st of each month at 10:00"],
  ])("%s → %s", (expr, text) => {
    expect(describeCron(expr)).toBe(text);
  });

  it("a shape it does not know is shown as the cron expression, never guessed", () => {
    expect(describeCron("5 4 * * 2,4")).toBe("cron 5 4 * * 2,4");
  });
});
