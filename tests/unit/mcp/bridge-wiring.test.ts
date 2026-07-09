/**
 * Unit tests for the department-merge wiring (ADR-041): mergeBridgedTools is the
 * pure core that applyMcpBridge() runs only when the flag is on. We test the
 * merge directly (flag-on logic) and assert applyMcpBridge is a no-op when the
 * flag is off (default in the test env).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import {
  mergeBridgedTools,
  applyMcpBridge,
  DEPARTMENT_TOOLS,
  HITL_GATED_TOOLS,
} from "../../../src/agents/capabilities.js";
import { gatedRuntimeNames } from "../../../src/mcp/bridge-classify.js";
import { bridgeManifestSchema } from "../../../src/mcp/bridge-manifest.js";

function t(name: string) {
  return tool(async () => "ok", { name, description: name, schema: z.object({}) });
}

describe("mergeBridgedTools", () => {
  it("appends tools to their department and registers gated names as HITL", () => {
    const target: Record<string, unknown[]> = { personal: [t("read_file")] };
    const hitl = new Set<string>();
    const byDept = { personal: [t("mcp__blender__execute_blender_code")] };

    mergeBridgedTools(target, hitl, byDept, ["mcp__blender__execute_blender_code"]);

    expect((target["personal"] as { name: string }[]).map((x) => x.name)).toEqual([
      "read_file",
      "mcp__blender__execute_blender_code",
    ]);
    expect(hitl.has("mcp__blender__execute_blender_code")).toBe(true);
  });

  it("creates a department array when the target has none yet", () => {
    const target: Record<string, unknown[]> = {};
    mergeBridgedTools(target, new Set(), { comms: [t("mcp__slack__post")] }, []);
    expect((target["comms"] as { name: string }[]).map((x) => x.name)).toEqual(["mcp__slack__post"]);
  });
});

describe("gatedRuntimeNames", () => {
  it("derives runtime names from manifest write allowlists", () => {
    const m = bridgeManifestSchema.parse({
      servers: {
        blender: { command: "uvx", department: "personal", write: ["execute_blender_code"] },
        slack: { command: "npx", department: "comms", write: ["slack_post_message"] },
      },
    });
    expect(gatedRuntimeNames(m).sort()).toEqual([
      "mcp__blender__execute_blender_code",
      "mcp__slack__slack_post_message",
    ]);
  });
});

describe("applyMcpBridge — flag off (default test env)", () => {
  it("is a no-op: leaves DEPARTMENT_TOOLS and HITL_GATED_TOOLS untouched", async () => {
    const before = Object.fromEntries(
      Object.entries(DEPARTMENT_TOOLS).map(([d, ts]) => [d, ts.length]),
    );
    const hitlBefore = HITL_GATED_TOOLS.size;

    await applyMcpBridge();

    for (const [d, n] of Object.entries(before)) {
      expect(DEPARTMENT_TOOLS[d]?.length).toBe(n);
    }
    expect(HITL_GATED_TOOLS.size).toBe(hitlBefore);
  });
});
