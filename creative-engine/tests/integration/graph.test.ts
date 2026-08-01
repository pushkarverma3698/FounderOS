import { describe, it, expect, afterAll } from "vitest";
import { buildCreativeGraph } from "../../src/graph/graph.js";
import { closeSharedBrowser } from "../../src/compose/browser.js";
import { writeOutputBundle } from "../../src/bundle/writer.js";

describe("E2E Creative Engine 11-Node Graph Execution", () => {
  afterAll(async () => {
    await closeSharedBrowser();
  });

  it("executes all 11 nodes from intent to packaged bundle within budget", async () => {
    const graph = buildCreativeGraph();

    const initialState = {
      runId: `run-${Date.now()}`,
      createdAt: new Date().toISOString(),
      budget: { usdCap: 1.5, spentUsd: 0, cheapIters: 0, expensiveIters: 0 },
      intent: "Promote health empowerment seminar on Instagram",
      sources: [{ kind: "text", ref: "Health seminar details" }],
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
    expect(finalState.brand).toBeDefined();
    expect(finalState.direction).toBeDefined();
    expect(finalState.plates.length).toBeGreaterThan(0);
    expect(finalState.variants.length).toBeGreaterThan(0);
    expect(finalState.selected).toBeDefined();
    expect(finalState.status).toBe("done");

    // Verify budget constraints
    expect(finalState.budget.spentUsd).toBeLessThanOrEqual(1.5);

    // Test output bundle packaging
    const bundle = writeOutputBundle(finalState.runId, finalState, "./runs");
    expect(bundle.caption).toContain("HEALTH");
    expect(bundle.distributionPlan).toContain("Instagram");
  }, 30000);
});
