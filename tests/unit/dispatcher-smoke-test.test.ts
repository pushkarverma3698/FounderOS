/**
 * Smoke test for agent-dispatch loop verification.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const smokeTestFilePath = fileURLToPath(
  new URL("../../docs/antigravity/DISPATCHER-SMOKE-TEST.md", import.meta.url)
);

describe("dispatcher smoke test", () => {
  it("contains the exact AGENT-DISPATCH-SMOKE-MARKER line in DISPATCHER-SMOKE-TEST.md", () => {
    const content = readFileSync(smokeTestFilePath, "utf8");
    const lines = content.split("\n").map((line) => line.trim());

    expect(lines).toContain("AGENT-DISPATCH-SMOKE-MARKER");
  });

  it("does not match an arbitrary non-existent marker line", () => {
    const content = readFileSync(smokeTestFilePath, "utf8");
    const lines = content.split("\n").map((line) => line.trim());

    expect(lines).not.toContain("NON_EXISTENT_SMOKE_MARKER");
  });
});
