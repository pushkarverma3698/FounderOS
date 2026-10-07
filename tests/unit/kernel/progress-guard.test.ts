/**
 * AG-034: a present-progress claim about an agent or task needs a successful status
 * receipt this turn. Fixtures are the prod replies named in the brief.
 */
import { describe, it, expect } from "vitest";
import type { StepResult } from "../../../src/kernel/index.js";
import {
  NO_STATUS_NOTICE,
  PROGRESS_PHRASES,
  STATUS_TOOLS,
  stripUnbackedProgress,
} from "../../../src/kernel/progress-guard.js";

function okResult(tool: string, ok = true): StepResult {
  return {
    step_id: "s1",
    status: "ok",
    output: {},
    tool_receipts: [
      { tool, args_hash: "a".repeat(64), result_digest: "b".repeat(64), ok, at: "2026-10-05T10:00:00.000Z" },
    ],
  } as unknown as StepResult;
}


describe("stripUnbackedProgress", () => {
  it("#396: actively executing with no status tool is replaced", () => {
    const reply = "Antigravity is currently actively executing the implementation, test suite and verification pipeline in its ISO workspace.";
    expect(stripUnbackedProgress(reply, [okResult("dispatch_task")])).toBe(NO_STATUS_NOTICE);
  });

  it("keeps the lines around the unbacked one, byte for byte", () => {
    const reply = "Task 76 was dispatched.\nThe agent is working on it.\nNo PR yet.";
    expect(stripUnbackedProgress(reply, [])).toBe("Task 76 was dispatched.\n" + NO_STATUS_NOTICE + "\nNo PR yet.");
  });

  it("keeps an unaffected sentence on the same line", () => {
    const out = stripUnbackedProgress("Task 76 was dispatched. The agent is working on it.", []);
    expect(out).toBe("Task 76 was dispatched. " + NO_STATUS_NOTICE);
  });

  it("emits the notice once when several sentences claim progress", () => {
    expect(stripUnbackedProgress("The agent is working on it. The build is in progress.", [])).toBe(NO_STATUS_NOTICE);
  });

  it("passes when a successful antigravity_task_status receipt exists", () => {
    const reply = "Antigravity is actively executing task 76.";
    expect(stripUnbackedProgress(reply, [okResult("antigravity_task_status")])).toBe(reply);
  });

  it("a failed status receipt does not back the claim", () => {
    const out = stripUnbackedProgress("Antigravity is working on task 76.", [okResult("antigravity_task_status", false)]);
    expect(out).toBe(NO_STATUS_NOTICE);
  });

  it("text without a progress phrase is returned untouched", () => {
    const reply = "No branch and no PR exist.\n  Nothing observed why.  ";
    expect(stripUnbackedProgress(reply, [])).toBe(reply);
  });

  it("prod 2026-10-07 10:44: 'claimed' after a dispatch, with no status read, is replaced", () => {
    const reply = "Done. Issue #83 is filed and an Antigravity agent has claimed it.\nhttps://github.com/o/r/issues/83";
    expect(stripUnbackedProgress(reply, [])).toBe(`Done. ${NO_STATUS_NOTICE}\nhttps://github.com/o/r/issues/83`);
  });

  it.each([
    ["agent-dispatch picks it up within 15 minutes, usually at once."],
    ["The VPS agent-dispatch loop will pick it up on its next tick."],
    ["✅ #41 is queued for Google Antigravity (same issue, nothing new filed). No agent is on it yet."],
    ["#41 is already fixed — PR #81 merged into beta."],
  ])("a future or negative statement passes: %s", (reply) => {
    expect(stripUnbackedProgress(reply, [])).toBe(reply);
  });

  it("STATUS_TOOLS names the three status sources", () => {
    expect([...STATUS_TOOLS].sort()).toEqual(["antigravity_task_status", "github_read", "read_logs"]);
  });

const SAMPLES = PROGRESS_PHRASES.map(function (p) {
  return p.sample;
});
it.each(SAMPLES)("progress phrase %s is caught without a receipt", function (sample) {
  const reply = sample.concat(".");
  expect(stripUnbackedProgress(reply, [])).toBe(NO_STATUS_NOTICE);
  expect(stripUnbackedProgress(reply, [okResult("read_logs")])).toBe(reply);
});
});
