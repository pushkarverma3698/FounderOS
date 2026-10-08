import { describe, expect, it } from "vitest";
import { isProgressChatter } from "../../../scripts/lib/bot-progress.js";

describe("isProgressChatter", () => {
  it("skips the gateway's progress placeholders and step labels", () => {
    for (const t of ["🤔 Working on it…", "🧠 Thinking", "On it: reading your inbox", "Step 2 of 3: calendar", "All 3 steps done", "  "]) {
      expect(isProgressChatter(t), t).toBe(true);
    }
  });
  it("keeps a real answer", () => {
    expect(isProgressChatter("You have 2 open PRs: #1036 (CI green), #1002 (CI red).")).toBe(false);
    expect(isProgressChatter("Step 2 is what blocks it: lint fails.")).toBe(false);
  });
});
