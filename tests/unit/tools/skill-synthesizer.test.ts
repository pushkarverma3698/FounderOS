import { describe, it, expect, afterAll } from "vitest";
import { synthesizeSkillImpl } from "../../../src/tools/skill-synthesizer.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("Hermes Skill Synthesizer", () => {
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
});
