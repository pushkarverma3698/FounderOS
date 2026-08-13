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
import { hitlGate } from "../infra/hitl.js";

const execAsync = promisify(exec);
const log = childLogger({ module: "tool:skill-synthesizer" });

/** Exported so the boot-time loader (src/agents/skill-loader.ts) scans the
 *  SAME directory this writes to — one path, never two constants to drift. */
export const CUSTOM_TOOLS_DIR = path.resolve("./src/tools/custom");
const CUSTOM_TESTS_DIR = path.resolve("./tests/unit/tools/custom");

/**
 * The one sanitizer for a synthesized tool's identifier. Exported so the
 * loader re-derives a tool's registered name from its filename at LOAD time
 * with the exact same function used at WRITE time here — untrusted-input
 * discipline: the loader must never trust what a file on disk claims about
 * its own name, only what this deterministic function says given the
 * filename it actually has.
 */
export function sanitizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

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
  const safeName = sanitizeSkillName(name);
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
    // Read at CALL time, not from the frozen `env` export (src/core/config.ts) —
    // same reasoning as kernel-boot.ts's isUnconfiguredTool: a flag nobody can
    // flip inside a test is a flag nobody can prove reflects reality, and the
    // message below has to be honest about whichever state is live RIGHT NOW,
    // not whatever it was when this process booted.
    const loaderEnabled = process.env["SKILL_SYNTHESIS_ENABLED"] === "true";
    const registrationNote = loaderEnabled
      ? `It will be loaded and made callable by src/agents/skill-loader.ts starting from the NEXT process restart — it is not callable this turn (SKILL_SYNTHESIS_ENABLED is currently ON).`
      : `SKILL_SYNTHESIS_ENABLED is currently OFF, so the boot-time loader (src/agents/skill-loader.ts) will NOT load it even after a restart — nothing will make it callable until that flag is flipped on.`;
    return {
      success: true,
      name: safeName,
      toolPath,
      testPath,
      message: `✅ Skill "${safeName}" synthesized and typechecked, saved to ${toolPath}. ${registrationNote}`,
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
  async (args, config) => {
    // HITL BEFORE the first filesystem write (rule #3). synthesizeSkillImpl writes
    // TypeScript into the running app's own source tree, so approval has to fire
    // here, ahead of it — SKILL_SYNTHESIS_ENABLED (kernel-boot) only decides
    // whether the tool is OFFERED, and membership in HITL_GATED_TOOLS has no
    // runtime effect at all. This call is the second lock those two describe.
    const rejected = await hitlGate(
      {
        action: "synthesize_skill",
        title: `🧬 Synthesize new tool "${args.name}"?`,
        summary: `Writes ${args.tsCode.length} chars of TypeScript into src/tools/custom/ — the running app's source tree`,
        preview: args.tsCode.slice(0, 2000),
        args: { name: args.name, description: args.description },
      },
      config,
    );
    if (rejected) return rejected;

    const result = await synthesizeSkillImpl(args);
    return result.message;
  },
  {
    name: "synthesize_skill",
    description:
      "Author and typecheck a new custom TypeScript tool module, saved to src/tools/custom/. " +
      "This does NOT register it as a callable tool this turn: a boot-time loader " +
      "(src/agents/skill-loader.ts) validates and merges it into the live tool set on the " +
      "NEXT process restart, only if SKILL_SYNTHESIS_ENABLED is on at that boot. The result " +
      "message states which of those is currently true.",
    schema: z.object({
      name: z.string().describe("Snake_case identifier for the tool (e.g. scrape_competitor_pricing)"),
      description: z.string().describe("Human-readable description of what the synthesized tool does"),
      tsCode: z.string().describe("Complete TypeScript implementation code for the tool"),
      testCode: z.string().optional().describe("Optional Vitest unit test code to verify tool behavior"),
    }),
  },
);
