/**
 * P2-7 (docs/plans/2026-10-04-telegram-ux-audit.md, F17): "I'll monitor … and keep you
 * posted" with nothing behind it. No watcher exists in the kernel except a scheduled
 * task or a reminder, so the sentence is stripped unless one of those ran.
 */

import { describe, it, expect } from "vitest";
import type { StepResult } from "../../../src/kernel/index.js";
import {
  NO_WATCHER_NOTICE,
  WATCHER_TOOLS,
  stripFalsePromises,
} from "../../../src/kernel/promise-guard.js";

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

describe("stripFalsePromises", () => {
  it("removes a monitor/keep-you-posted promise when no watcher was scheduled", () => {
    const out = stripFalsePromises("Dispatched issue #762 to the agent. I'll monitor it and keep you posted.", [okResult("dispatch_task")]);
    expect(out).toBe("Dispatched issue #762 to the agent.");
  });

  it("cuts only the promise clause when it trails a fact in the same sentence", () => {
    const out = stripFalsePromises("Issue #762 is queued as task 76, and I'll keep you posted.", []);
    expect(out).toBe("Issue #762 is queued as task 76.");
  });

  it("handles a curly apostrophe and different wording", () => {
    const out = stripFalsePromises("PR #5 is open. I’ll keep an eye on the checks.", []);
    expect(out).toBe("PR #5 is open.");
  });

  it("keeps the promise when schedule_task actually ran", () => {
    const text = "Scheduled. I'll keep you posted.";
    expect(stripFalsePromises(text, [okResult("schedule_task")])).toBe(text);
  });

  it("keeps the promise when a reminder was set", () => {
    const text = "Reminder set for 3pm. I'll let you know then.";
    expect(stripFalsePromises(text, [okResult("set_reminder")])).toBe(text);
  });

  it("does not count a FAILED watcher receipt as a watcher", () => {
    expect(stripFalsePromises("Queued. I'll monitor it.", [okResult("schedule_task", false)])).toBe("Queued.");
  });

  it("leaves text with no promise untouched, byte for byte", () => {
    const text = "Task #76 was dispatched.\n\n• Repo: founderos\n• No PR exists yet.";
    expect(stripFalsePromises(text, [])).toBe(text);
  });

  it("does not touch a negative or an offer", () => {
    const text = "I won't monitor this on my own. I can check it again if you ask.";
    expect(stripFalsePromises(text, [])).toBe(text);
  });

  it("keeps line breaks of the surviving lines", () => {
    const out = stripFalsePromises("Dispatched.\nI'll monitor Issue #762 and keep you posted.\nRepo: founderos", []);
    expect(out).toBe("Dispatched.\nRepo: founderos");
  });

  it("says plainly that nothing is watching when the promise was the whole reply", () => {
    const out = stripFalsePromises("I'll monitor Issue #762 and keep you posted.", []);
    expect(out).toBe(NO_WATCHER_NOTICE);
    expect(NO_WATCHER_NOTICE).not.toMatch(/I'll|keep you posted/);
  });

  it("names exactly the tools that can really notify later", () => {
    expect([...WATCHER_TOOLS].sort()).toEqual(["schedule_task", "set_reminder"]);
  });
});
