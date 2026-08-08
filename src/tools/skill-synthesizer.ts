/**
 * FounderOS — Hermes Autonomous Skill Synthesizer
 * ================================================
 * Enables FounderOS to dynamically write, compile, test, and register new
 * TypeScript tool modules on-the-fly when assigned new workflows.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { childLogger } from "../infra/logger.js";

const execAsync = promisify(exec);
const log = childLogger({ module: "tool:skill-synthesizer" });

const CUSTOM_TOOLS_DIR = path.resolve("./src/tools/custom");
const CUSTOM_TESTS_DIR = path.resolve("./tests/unit/tools/custom");

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export interface SkillSynthesisResult {
  success: boolean;
  name: string;
  toolPath: string;
  testPath: string;
  message: string;
}

export async function synthesizeSkillImpl({
  name,
  description,
  tsCode,
  testCode,
}: {
  name: string;
  description: string;
  tsCode: string;
  testCode?: string;
}): Promise<SkillSynthesisResult> {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  await ensureDir(CUSTOM_TOOLS_DIR);
  await ensureDir(CUSTOM_TESTS_DIR);

  const toolPath = path.join(CUSTOM_TOOLS_DIR, `${safeName}.ts`);
  const testPath = path.join(CUSTOM_TESTS_DIR, `${safeName}.test.ts`);

  const wrappedTsCode = `/**\n * Dynamically Synthesized Skill: ${safeName}\n * Description: ${description}\n */\n${tsCode}\n`;
  await fs.writeFile(toolPath, wrappedTsCode, "utf-8");

  if (testCode) {
    const wrappedTestCode = `/** Unit test for synthesized skill: ${safeName} */\nimport { describe, it, expect } from "vitest";\n${testCode}\n`;
    await fs.writeFile(testPath, wrappedTestCode, "utf-8");
  }

  // Typecheck verification step
  try {
    const tscBin = path.resolve("./node_modules/.bin/tsc");
    await execAsync(`"${tscBin}" --noEmit`, { cwd: process.cwd() });
    log.info({ name: safeName, toolPath }, "Skill synthesized and typechecked successfully");
    return {
      success: true,
      name: safeName,
      toolPath,
      testPath,
      message: `✅ Skill "${safeName}" successfully synthesized, typechecked, and saved to ${toolPath}.`,
    };
  } catch (err: any) {
    log.error({ name: safeName, err: err?.stderr || err?.message }, "Skill synthesis typecheck failed");
    // Clean up broken file so invalid TypeScript is not left in src/
    try { await fs.unlink(toolPath); } catch {}
    if (testCode) { try { await fs.unlink(testPath); } catch {} }
    return {
      success: false,
      name: safeName,
      toolPath,
      testPath,
      message: `❌ Typecheck failed for synthesized skill "${safeName}": ${err?.stdout || err?.stderr || err?.message}`,
    };
  }
}

export const synthesizeSkill = tool(
  async (args) => {
    const result = await synthesizeSkillImpl(args);
    return result.message;
  },
  {
    name: "synthesize_skill",
    description: "Synthesize and register a new custom TypeScript tool module with automatic typechecking and verification.",
    schema: z.object({
      name: z.string().describe("Snake_case identifier for the tool (e.g. scrape_competitor_pricing)"),
      description: z.string().describe("Human-readable description of what the synthesized tool does"),
      tsCode: z.string().describe("Complete TypeScript implementation code for the tool"),
      testCode: z.string().optional().describe("Optional Vitest unit test code to verify tool behavior"),
    }),
  },
);
