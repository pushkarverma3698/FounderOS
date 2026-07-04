/**
 * P3 wiring: REVENUE_SUBGRAPH flag swaps marketing+sales for revenue sub-supervisor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

async function compileOfficeNodes(
  revenueFlag: string | undefined,
  engineeringFlag?: string | undefined,
): Promise<string[]> {
  vi.resetModules();
  if (revenueFlag === undefined) delete process.env["REVENUE_SUBGRAPH"];
  else process.env["REVENUE_SUBGRAPH"] = revenueFlag;
  if (engineeringFlag === undefined) delete process.env["ENGINEERING_SUBGRAPH"];
  else process.env["ENGINEERING_SUBGRAPH"] = engineeringFlag;
  const { buildOffice } = await import("../../../src/agents/office.js");
  const office = buildOffice(new MemorySaver());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (office as any).builder?.nodes ?? (office as any).nodes ?? {};
  return Object.keys(nodes);
}

describe("P3 — revenue subgraph flag wiring", () => {
  beforeEach(() => {
    delete process.env["REVENUE_SUBGRAPH"];
    delete process.env["ENGINEERING_SUBGRAPH"];
  });
  afterEach(() => {
    delete process.env["REVENUE_SUBGRAPH"];
    delete process.env["ENGINEERING_SUBGRAPH"];
  });

  it("flag off (REVENUE_SUBGRAPH=0): flat marketing + sales nodes (no revenue)", async () => {
    const nodes = await compileOfficeNodes("0");
    expect(nodes).toContain("marketing");
    expect(nodes).toContain("sales");
    expect(nodes).not.toContain("revenue");
    expect(nodes).toContain("admin");
  });

  it("default (flag unset → prod default FALSE): flat marketing + sales, no revenue", async () => {
    // 2026-06-29: default restored to false. Production runs the flat,
    // production-stable marketing + sales departments; the revenue sub-supervisor
    // is opt-in until its nested-HITL loop is live-verified (rule #19.6).
    const nodes = await compileOfficeNodes(undefined);
    expect(nodes).toContain("marketing");
    expect(nodes).toContain("sales");
    expect(nodes).not.toContain("revenue");
    expect(nodes).toContain("admin");
  });

  it("flag on (REVENUE_SUBGRAPH=1): revenue replaces marketing + sales at top level", async () => {
    const nodes = await compileOfficeNodes("1");
    expect(nodes).toContain("revenue");
    expect(nodes).not.toContain("marketing");
    expect(nodes).not.toContain("sales");
    expect(nodes).toContain("admin");
  });
});
