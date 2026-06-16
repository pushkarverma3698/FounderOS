/**
 * ADR-028 — structural guard: managers never carry business tools.
 * Pure file reads + registry checks — no LLM, no network.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SUPERVISOR_TOOLS } from "../../../src/agents/capabilities.js";

const AGENTS_DIR = join(process.cwd(), "src", "agents");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("ADR-028 — manager has no business tools", () => {
  it("SUPERVISOR_TOOLS is empty (Chief of Staff routes only)", () => {
    expect(SUPERVISOR_TOOLS).toEqual([]);
  });

  it("office.ts does not pass business tools to createSupervisor", () => {
    const src = readFileSync(join(AGENTS_DIR, "office.ts"), "utf8");
    expect(src).not.toMatch(/createSupervisor\(\{[\s\S]*?tools:\s*SUPERVISOR_TOOLS/);
    expect(src).not.toMatch(/tools:\s*\[readContext/);
  });

  it("every createSupervisor call omits a business tools array", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(AGENTS_DIR)) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("createSupervisor(")) continue;
      // Business tools wired into a supervisor (not handoff internals).
      if (/createSupervisor\(\{[^}]*tools:\s*\[/.test(src.replace(/\n/g, " "))) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("engineering CTO prompt forbids self-execution", () => {
    const src = readFileSync(join(AGENTS_DIR, "engineering-domain.ts"), "utf8");
    expect(src).toMatch(/NO tools of your own/i);
  });

  it("supervisor prompt routes memory/context to admin — does not claim own tools", async () => {
    const { SUPERVISOR_PROMPT } = await import("../../../src/agents/system-prompts.js");
    expect(SUPERVISOR_PROMPT).toMatch(/admin/i);
    expect(SUPERVISOR_PROMPT).not.toMatch(/YOUR 4 TOOLS/i);
    expect(SUPERVISOR_PROMPT).not.toMatch(/read_context\s+→/);
  });
});
