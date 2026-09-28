/**
 * A worker prompt never advertises a tool the worker does not hold.
 * =================================================================
 * Each department prompt lists its tools as "- tool_name → what it does". The
 * model reads that list as the truth. When a tool leaves DEPARTMENT_TOOLS and its
 * prompt line stays, the worker is told to call something it cannot call — the
 * best case is a wasted turn, the worst an invented result. Prompt and registry
 * are edited in different files, so nothing but this test keeps them in step.
 */

import { describe, it, expect } from "vitest";
import { buildWorkerSpecs } from "../../../src/gateway/kernel-boot.js";
import { DEPARTMENT_TOOLS } from "../../../src/agents/capabilities.js";

/** Tool names a prompt advertises: lines shaped "- tool_name  → description". */
function advertisedTools(prompt: string): string[] {
  return [...prompt.matchAll(/^- ([a-z][a-z0-9_]+)\s+→/gm)].map((m) => m[1]!);
}

describe("worker prompts advertise only tools the worker holds", () => {
  const specs = buildWorkerSpecs();

  it("parses the tool list out of real prompts (else the check below proves nothing)", () => {
    const research = specs.find((s) => s.id === "research")!;
    expect(advertisedTools(research.prompt)).toContain("search_knowledge");
  });

  it.each(specs.map((s) => [s.id, s] as const))("%s", (id, spec) => {
    // Compared against the full registry, not spec.tools: buildWorkerSpecs
    // withholds unconfigured tools (vps_run, synthesize_skill) at boot, and a
    // prompt may still describe them for when they are configured.
    const held = new Set((DEPARTMENT_TOOLS[id] ?? []).map((t: { name: string }) => t.name));
    const phantom = advertisedTools(spec.prompt).filter((name) => !held.has(name));
    expect(phantom, `${id}'s prompt advertises tools it does not hold`).toEqual([]);
  });
});
