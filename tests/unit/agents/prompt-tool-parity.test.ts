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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Every src .ts file outside the prompts themselves — where a directive would have to be emitted. */
function emitterSources(): string[] {
  const src = fileURLToPath(new URL("../../../src", import.meta.url));
  return readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => !path.includes(join("agents", "prompts")))
    .map((path) => readFileSync(path, "utf8"));
}

describe("worker prompts branch only on directives something emits", () => {
  // prompts/research.ts carried "ROUTING OVERRIDES (beat every other rule in this
  // prompt)" keyed on "EXTERNAL LEAD DISCOVERY" / "INTERNAL KNOWLEDGE" directives.
  // Their only emitter was the v2 pre-router, deleted on 2026-07-08; the worker
  // kept reading its highest-priority rule for text that could never arrive.
  const sources = emitterSources();

  it.each(buildWorkerSpecs().map((s) => [s.id, s.prompt] as const))("%s", (_id, prompt) => {
    const directives = [...prompt.matchAll(/directive contains "([^"]+)"/gi)].map((m) => m[1]!);
    const orphaned = directives.filter((d) => !sources.some((text) => text.includes(d)));
    expect(orphaned, "prompt rules keyed on directives no code emits").toEqual([]);
  });
});
