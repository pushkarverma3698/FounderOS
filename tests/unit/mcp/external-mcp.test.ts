/**
 * Unit tests for gateMcpTool — the external MCP read/write safety wrapper (ADR-041).
 * hitlGate and the audit queries are mocked so we assert the control flow without
 * a real interrupt() or Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ── Mocks ─────────────────────────────────────────────────────────────────────
const hitlGate = vi.fn();
const hasBeenAudited = vi.fn();
const writeAuditEntry = vi.fn();

vi.mock("../../../src/agents/agent-tools/hitl.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/agents/agent-tools/hitl.js")>(
    "../../../src/agents/agent-tools/hitl.js",
  );
  return { ...actual, hitlGate: (...a: unknown[]) => hitlGate(...a) };
});

vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: (...a: unknown[]) => hasBeenAudited(...a),
  writeAuditEntry: (...a: unknown[]) => writeAuditEntry(...a),
}));

import { gateMcpTool, type LoadedMcpTool } from "../../../src/agents/agent-tools/external-mcp.js";
import { bridgeManifestSchema } from "../../../src/mcp/bridge-manifest.js";

const manifest = bridgeManifestSchema.parse({
  servers: {
    blender: { command: "uvx", department: "personal", write: ["execute_blender_code"] },
  },
});

function fakeTool(name: string, invoke: LoadedMcpTool["invoke"]): LoadedMcpTool {
  return { name, description: `desc ${name}`, schema: z.object({ x: z.string().optional() }), invoke };
}

beforeEach(() => {
  hitlGate.mockReset();
  hasBeenAudited.mockReset().mockResolvedValue(false);
  writeAuditEntry.mockReset().mockResolvedValue({ written: true });
});

describe("gateMcpTool — read tools", () => {
  it("invokes a read tool directly without gating", async () => {
    const invoke = vi.fn().mockResolvedValue("scene data");
    const t = gateMcpTool(fakeTool("get_scene_info", invoke), "blender", manifest);
    const out = await t.invoke({ x: "1" });
    expect(out).toBe("scene data");
    expect(hitlGate).not.toHaveBeenCalled();
    expect(t.name).toBe("mcp__blender__get_scene_info");
  });

  it("maps a thrown read error to a stage-tagged failure envelope", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("server down"));
    const t = gateMcpTool(fakeTool("get_scene_info", invoke), "blender", manifest);
    const out = await t.invoke({});
    expect(out).toMatch(/\[\[TOOL_FAILURE stage=external_api\]\]/);
    expect(out).toContain("server down");
  });
});

describe("gateMcpTool — write tools", () => {
  it("calls hitlGate BEFORE invoking the side effect, then audits", async () => {
    hitlGate.mockResolvedValue(null); // approved
    const invoke = vi.fn().mockResolvedValue("rendered");
    const t = gateMcpTool(fakeTool("execute_blender_code", invoke), "blender", manifest);

    const out = await t.invoke({ x: "code" });

    expect(hitlGate).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    // gate fired before the side effect
    expect(hitlGate.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(out).toContain("✅ mcp__blender__execute_blender_code done");
  });

  it("returns the rejection string and never invokes on rejection", async () => {
    hitlGate.mockResolvedValue("❌ Rejected by founder.");
    const invoke = vi.fn();
    const t = gateMcpTool(fakeTool("execute_blender_code", invoke), "blender", manifest);

    const out = await t.invoke({ x: "code" });

    expect(out).toBe("❌ Rejected by founder.");
    expect(invoke).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it("derives the SAME idempotency key regardless of arg key order (H1)", async () => {
    hitlGate.mockResolvedValue(null);
    const keys: string[] = [];
    hasBeenAudited.mockImplementation((k: string) => {
      keys.push(k);
      return Promise.resolve(false);
    });
    const t = gateMcpTool(
      fakeTool("execute_blender_code", vi.fn().mockResolvedValue("ok")),
      "blender",
      manifest,
    );
    await t.invoke({ a: "1", b: "2" });
    await t.invoke({ b: "2", a: "1" }); // same args, different key order
    expect(keys[0]).toBe(keys[1]);
  });

  it("short-circuits on a duplicate idempotency key", async () => {
    hasBeenAudited.mockResolvedValue(true);
    const invoke = vi.fn();
    const t = gateMcpTool(fakeTool("execute_blender_code", invoke), "blender", manifest);

    const out = await t.invoke({ x: "code" });

    expect(out).toMatch(/skipped duplicate/);
    expect(hitlGate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
