/**
 * P1 wiring: CREATIVE_SUBGRAPH flag ADDS the `creative` nested sub-supervisor as
 * an extra routing target. Unlike revenue/engineering it does not replace any
 * node, so with the flag OFF the node set is unchanged (no routing regression).
 *
 * This compiles the REAL office graph (construction only — no model call), so it
 * proves the creative sub-supervisor wires into the parent without error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

async function compileOfficeNodes(creativeFlag: string | undefined): Promise<string[]> {
  vi.resetModules();
  if (creativeFlag === undefined) delete process.env["CREATIVE_SUBGRAPH"];
  else process.env["CREATIVE_SUBGRAPH"] = creativeFlag;
  const { buildOffice } = await import("../../../src/agents/office.js");
  const office = buildOffice(new MemorySaver());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (office as any).builder?.nodes ?? (office as any).nodes ?? {};
  return Object.keys(nodes);
}

describe("P1 — creative subgraph flag wiring", () => {
  beforeEach(() => delete process.env["CREATIVE_SUBGRAPH"]);
  afterEach(() => delete process.env["CREATIVE_SUBGRAPH"]);

  it("default (flag unset): no creative node — production routing surface unchanged", async () => {
    const nodes = await compileOfficeNodes(undefined);
    expect(nodes).not.toContain("creative");
    expect(nodes).toContain("admin");
    expect(nodes).toContain("research");
  });

  it("flag off (CREATIVE_SUBGRAPH=0): no creative node", async () => {
    const nodes = await compileOfficeNodes("0");
    expect(nodes).not.toContain("creative");
  });

  it("flag on (CREATIVE_SUBGRAPH=1): office compiles with a creative node added", async () => {
    const nodes = await compileOfficeNodes("1");
    expect(nodes).toContain("creative");
    // existing departments are still present — creative is additive, not a replacement
    expect(nodes).toContain("admin");
    expect(nodes).toContain("personal");
  });
});
