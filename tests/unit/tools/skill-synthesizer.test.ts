import { describe, it, expect, afterAll } from "vitest";
import { synthesizeSkillImpl, synthesizeSkill } from "../../../src/tools/skill-synthesizer.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("Hermes Skill Synthesizer", { timeout: 60000 }, () => {
  afterAll(async () => {
    try { await fs.unlink(path.resolve("./src/tools/custom/test_calculator.ts")); } catch {}
    try { await fs.unlink(path.resolve("./tests/unit/tools/custom/test_calculator.test.ts")); } catch {}
    try { await fs.unlink(path.resolve("./src/tools/custom/broken_tool.ts")); } catch {}
    try { await fs.unlink(path.resolve("./tests/unit/tools/custom/broken_tool.test.ts")); } catch {}
  });

  it("synthesizes valid TypeScript tool code and passes typecheck", async () => {
    const res = await synthesizeSkillImpl({
      name: "test_calculator",
      description: "Simple test calculator tool",
      tsCode: `export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n`,
      testCode: `import { addNumbers } from "../../../src/tools/custom/test_calculator.js";\nit("adds", () => { expect(addNumbers(2, 3)).toBe(5); });`,
    });

    expect(res.success).toBe(true);
    expect(res.name).toBe("test_calculator");
    expect(res.toolPath).toContain("test_calculator.ts");
  });

  it("fails gracefully and returns error evidence on invalid TypeScript syntax", async () => {
    const res = await synthesizeSkillImpl({
      name: "broken_tool",
      description: "Broken syntax tool",
      tsCode: `const x: number = "not a number";`,
    });

    expect(res.success).toBe(false);
    expect(res.message).toContain("Typecheck failed");
  });

  // ── Truth-in-advertising: the tool's stated capability must match what it
  // actually does now that src/agents/skill-loader.ts is real (2026-08-12
  // remediation of the "register" claim that used to be a lie). This checks
  // the static description only (no real tsc invocation needed — see
  // skill-synthesizer-load-message.test.ts for the success-message wording,
  // which mocks tsc so it doesn't pay the ~60-70s real-typecheck cost twice
  // more in this suite). ──────────────────────────────────────────────────
  it("description never claims synthesis alone registers a callable tool", () => {
    const description = (synthesizeSkill as unknown as { description: string }).description;
    // "does NOT register" / "NEXT process restart" are the load-bearing
    // truthful claims; a bare "register" verb with no such qualifier nearby
    // is exactly the 2026-08-12-audit-flagged lie.
    expect(description).toMatch(/does NOT register/i);
    expect(description).toContain("NEXT process restart");
    expect(description).toContain("SKILL_SYNTHESIS_ENABLED");
  });
});
