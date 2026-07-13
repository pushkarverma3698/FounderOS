/**
 * Regression test for the applyMcpBridge reload race (ADR-041).
 *
 * applyMcpBridge used to strip previously-merged bridged tools BEFORE awaiting
 * getBridgedTools(). Two overlapping invocations (startup racing a /connect
 * reload, or two turns racing through getKernel() after resetKernelCache())
 * interleave as strip → strip → merge → merge, duplicating every bridged tool
 * in DEPARTMENT_TOOLS — and during the await gap the live registry sits with
 * the bridged tools missing. Strip+merge must happen in one synchronous block
 * after the fetch resolves.
 *
 * Uses the injectable deps seam (same discipline as buildBridgedTools' client
 * factory): no adapter loads, no processes spawn, flag irrelevant.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  applyMcpBridge,
  stripBridgedTools,
  DEPARTMENT_TOOLS,
  HITL_GATED_TOOLS,
} from "../../../src/agents/capabilities.js";
import { bridgeManifestSchema } from "../../../src/mcp/bridge-manifest.js";

const release: Array<() => void> = [];

/** Fake deps: every getBridgedTools call parks on a promise the test releases,
 *  so the interleaving of concurrent invocations is deterministic. */
const deps = {
  loadManifest: () => bridgeManifestSchema.parse({ servers: {} }),
  getBridgedTools: async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return {
      byDept: { personal: [{ name: "mcp__fake__ping" }] },
      gatedNames: ["mcp__fake__ping"],
    };
  },
};

function waitForParkedCalls(n: number): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (release.length >= n) resolve();
      else setTimeout(check, 1);
    };
    check();
  });
}

function bridgedNamesIn(dept: string): string[] {
  return (DEPARTMENT_TOOLS[dept] ?? [])
    .map((t) => String(t.name))
    .filter((n) => n.startsWith("mcp__"));
}

describe("applyMcpBridge — concurrent reload", () => {
  afterEach(() => {
    stripBridgedTools();
    release.length = 0;
  });

  it("does not duplicate bridged tools when two invocations overlap", async () => {
    const first = applyMcpBridge(deps);
    const second = applyMcpBridge(deps);

    // Both calls are now parked inside getBridgedTools; release them in order.
    await waitForParkedCalls(2);
    for (const r of release) r();
    await Promise.all([first, second]);

    expect(bridgedNamesIn("personal")).toEqual(["mcp__fake__ping"]);
    expect(HITL_GATED_TOOLS.has("mcp__fake__ping")).toBe(true);
  });

  it("keeps previously-merged bridged tools visible while a reload is in flight", async () => {
    // Seed: one completed apply.
    const seed = applyMcpBridge(deps);
    await waitForParkedCalls(1);
    release[0]!();
    await seed;

    // Start a reload but do NOT release it yet — the registry must still
    // serve the previous bridge tools to in-flight turns.
    const reload = applyMcpBridge(deps);
    await waitForParkedCalls(2);
    expect(bridgedNamesIn("personal")).toEqual(["mcp__fake__ping"]);

    release[1]!();
    await reload;
    expect(bridgedNamesIn("personal")).toEqual(["mcp__fake__ping"]);
  });
});
