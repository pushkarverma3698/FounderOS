import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Phase 8 Smoke Test", () => {
  it("should contain PHASE8-SMOKE-MARKER in docs/antigravity/PHASE8-SMOKE-TEST.md", () => {
    const filePath = path.resolve(process.cwd(), "docs/antigravity/PHASE8-SMOKE-TEST.md");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("PHASE8-SMOKE-MARKER");
  });
});
