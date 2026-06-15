// tests/integration/log-review/state-checks.test.ts
import { describe, it, expect } from "vitest";
import { runStateChecks } from "../../../scripts/log-review/state-checks.js";

// DB-gated: only runs when a database is reachable.
const HAS_DB = !!process.env["DATABASE_URL"];

describe.skipIf(!HAS_DB)("runStateChecks", () => {
  it("returns StateFinding[] and never throws", async () => {
    const findings = await runStateChecks("turicks");
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(typeof f.summary).toBe("string");
      expect(["high", "medium", "low"]).toContain(f.severity);
    }
  });
});
