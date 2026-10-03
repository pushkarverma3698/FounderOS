import { describe, it, expect } from "vitest";

// DRILL (issue #806): this test fails on purpose so the loop's red-CI path can be seen end to end.
// The fix is to delete this file.
describe("drill: red CI", () => {
  it("fails on purpose; delete this file to fix", () => {
    expect(1).toBe(2);
  });
});
