/**
 * The standalone jobs process (2026-10-10): src/jobs/main.ts runs the job
 * pipeline and nothing else. These pin its three promises:
 *   1. the token is JOBS_BOT_TOKEN, falling back to TELEGRAM_BOT_TOKEN;
 *   2. the scheduler registers the jobs crons and only those;
 *   3. the import closure never reaches the kernel, the planner or the coding pipeline.
 */
import { describe, expect, it, vi } from "vitest";
import { importClosure } from "../../helpers/import-closure.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { resolveJobsBotToken } = await import("../../../src/infra/jobs-bot-token.js");
const { startJobsScheduler, JOBS_CRONS } = await import("../../../src/jobs/scheduler.js");

describe("bot token", () => {
  it("uses JOBS_BOT_TOKEN when it is set", () => {
    expect(resolveJobsBotToken({ JOBS_BOT_TOKEN: "111:jobs", TELEGRAM_BOT_TOKEN: "222:old" })).toEqual({
      token: "111:jobs",
      source: "JOBS_BOT_TOKEN",
    });
  });

  it("falls back to TELEGRAM_BOT_TOKEN, and says so, until the founder sets the new one", () => {
    expect(resolveJobsBotToken({ JOBS_BOT_TOKEN: "", TELEGRAM_BOT_TOKEN: "222:old" })).toEqual({
      token: "222:old",
      source: "TELEGRAM_BOT_TOKEN",
    });
  });

  it("throws, naming both variables, when neither is set", () => {
    expect(() => resolveJobsBotToken({})).toThrow(/JOBS_BOT_TOKEN.*TELEGRAM_BOT_TOKEN/);
  });
});

describe("scheduler", () => {
  it("registers exactly the jobs crons", () => {
    const registered: Array<{ expr: string; tz?: string }> = [];
    startJobsScheduler((expr, _fn, opts) => {
      registered.push({ expr, ...(opts?.timezone ? { tz: opts.timezone } : {}) });
    });

    expect(JOBS_CRONS.map((c) => c.name)).toEqual([
      "free-sweep",
      "follow-up",
      "pipeline-digest",
      "funding-grower",
      "import-boards-reminder",
      "findings",
    ]);
    expect(registered.map((r) => r.expr)).toEqual(["*/30 * * * *", "0 9 * * *", "0 9 * * 1", "0 2 * * *", "0 10 1 * *", "30 9 * * *"]);
    expect(registered.at(-1)?.tz).toBeTruthy(); // findings run in the founder's timezone
  });
});

describe("import closure", () => {
  const closure = importClosure(process.cwd(), ["src/jobs/main.ts"]);

  it("reaches no kernel, planner, agent tools or coding pipeline", () => {
    const banned = closure.filter((f) =>
      /^src\/(kernel|mcp|eval|goals)\/|^src\/agents\/agent-tools|^src\/gateway\/(kernel-run|telegram|commands|task-command|approval-card)\.ts$|^src\/evolution\/dispatch-findings\.ts$|^src\/infra\/(hitl|checkpointer)\.ts$/.test(f),
    );
    expect(banned).toEqual([]);
  });

  it("does reach the jobs pipeline it exists to run", () => {
    for (const f of [
      "src/tools/jobhunt/sweep-runner.ts",
      "src/tools/jobhunt/pipeline-followup.ts",
      "src/evolution/jobhunt-check.ts",
      "src/gateway/jobhunt-commands.ts",
      "src/gateway/jobhunt-callbacks.ts",
    ]) {
      expect(closure).toContain(f);
    }
  });
});
