import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The pipeline-v2 executor prompt (RULES) must carry the same scoped-verification rule as the legacy
// dispatcher heredoc: the full suite is CI's job, and a 6.5 min suite inside a 40 min budget is the
// failure mode PR #803 showed.
describe("executor prompt — verification scope", () => {
  const src = readFileSync("src/tools/executor-prompt.ts", "utf8");
  it("limits the executor to the tests it touched", () => {
    expect(src).toMatch(/only the test files you added or changed/i);
    expect(src).toMatch(/do not run the full `pnpm test`/i);
  });
});
