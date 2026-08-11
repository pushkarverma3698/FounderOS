import { describe, it, expect, afterAll } from "vitest";
import { buildCreativeGraph } from "../../src/graph/graph.js";
import { closeSharedBrowser } from "../../src/compose/browser.js";
import { writeOutputBundle } from "../../src/bundle/writer.js";

describe("E2E Skincare Brand Creative Generation", () => {
  afterAll(async () => {
    await closeSharedBrowser();
  });

  it("executes e2e graph for luxury organic skincare intent", async () => {
    const graph = buildCreativeGraph();

    const initialState = {
      runId: `run-skincare-${Date.now()}`,
      createdAt: new Date().toISOString(),
      budget: { usdCap: 1.5, spentUsd: 0, cheapIters: 0, expensiveIters: 0 },
      intent: "Promote luxury organic skincare serum launch with 20% early access discount",
      sources: [{ kind: "text", ref: "Skincare intent" }],
      brief: null,
      brand: null,
      strategy: null,
      concepts: [],
      chosenConcept: null,
      direction: null,
      plates: [],
      variants: [],
      findings: [],
      selected: null,
      approved: false,
      bundle: null,
      status: "running",
    };

    const finalState = await graph.invoke(initialState as any);

    expect(finalState.brief).toBeDefined();
    expect(finalState.brief.dynamicData.kicker).toContain("LUXURY");
    expect(finalState.brief.dynamicData.headline).toContain("RADIANCE");
    expect(finalState.brand.palette.accent).toBe("#2ecc71");
    expect(finalState.status).toBe("done");

    const bundle = writeOutputBundle(finalState.runId, finalState, "./runs");
    expect(bundle).toBeDefined();
  }, 30000);
});
