/**
 * P2 wiring (deterministic): the ENGINEERING_SUBGRAPH flag swaps the engineering
 * node between the flat ReAct agent (production default) and the CTO sub-supervisor
 * (coder/qa/devops) WITHOUT changing the supervisor's routable agent set.
 *
 * These are pure structural assertions — no network, no LLM — so the P2 wiring can
 * never silently regress (rule #16: push routing/topology guarantees into
 * deterministic tests, not prompt hope).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";

const ENG_NODE = "engineering";

/** Compile the office with the flag set, returning the compiled graph's node names. */
async function compileOfficeNodes(flag: string | undefined): Promise<string[]> {
  vi.resetModules();
  if (flag === undefined) delete process.env["ENGINEERING_SUBGRAPH"];
  else process.env["ENGINEERING_SUBGRAPH"] = flag;
  const { buildOffice } = await import("../../../src/agents/office.js");
  const office = buildOffice(new MemorySaver());
  // Compiled graphs expose their node map on the underlying graph.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (office as any).builder?.nodes ?? (office as any).nodes ?? {};
  return Object.keys(nodes);
}

describe("P2 — engineering subgraph flag wiring", () => {
  beforeEach(() => delete process.env["ENGINEERING_SUBGRAPH"]);
  afterEach(() => delete process.env["ENGINEERING_SUBGRAPH"]);

  it("default (flag unset): office compiles with a flat 'engineering' department node", async () => {
    const nodes = await compileOfficeNodes(undefined);
    expect(nodes).toContain(ENG_NODE);
    // All 7 departments routable regardless of topology.
    for (const dept of ["research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"]) {
      expect(nodes).toContain(dept);
    }
  });

  it("supervisor llm is plain getModel() — withFallbacks breaks bindTools", async () => {
    const src = readFileSync(join(process.cwd(), "src/agents/office.ts"), "utf8");
    expect(src).toMatch(/const llm = getModel\(\)/);
    expect(src).not.toMatch(/getSupervisorModel\(\)/);
  });

  it("flag on: office still exposes the SAME routable 'engineering' node (name unchanged)", async () => {
    const nodes = await compileOfficeNodes("1");
    expect(nodes).toContain(ENG_NODE);
    // The supervisor's routable agent set is identical — only the node's internal
    // topology (flat agent vs CTO sub-supervisor) changes.
    for (const dept of ["research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"]) {
      expect(nodes).toContain(dept);
    }
  });

  it("the CTO subgraph carries the documented small, domain-coherent sub-agent toolsets (ADR-027)", async () => {
    const { ENGINEERING_SUBAGENT_TOOLS } = await import("../../../src/agents/capabilities.js");
    const toolNames = (k: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ENGINEERING_SUBAGENT_TOOLS[k] ?? []).map((t: any) => t.name).sort();
    expect(toolNames("coder")).toEqual(["claude_code", "github_read"]);
    expect(toolNames("qa")).toEqual(["claude_code", "github_read"]);
    expect(toolNames("devops")).toEqual(["github_write", "project_workflow"]);
    // No sub-agent exceeds the ~10-tool split signal — small by role, not by decree.
    for (const k of ["coder", "qa", "devops"]) {
      expect((ENGINEERING_SUBAGENT_TOOLS[k] ?? []).length).toBeLessThanOrEqual(4);
    }
  });
});
