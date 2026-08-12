/**
 * Unit tests for deliverArtifact tool in src/agents/agent-tools/state.ts
 * Verifies that hitlGate interrupt throws are NOT swallowed by try/catch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const mockDeliverArtifactFile = vi.fn();

vi.mock("../../../src/agents/agent-tools/hitl.js", () => ({
  hitlGate: (...args: unknown[]) => mockHitlGate(...args),
}));

vi.mock("../../../src/tools/deliver-artifact.js", () => ({
  deliverArtifactFile: (...args: unknown[]) => mockDeliverArtifactFile(...args),
  deliverArtifactTool: { description: "mock deliver artifact tool" },
}));

const { deliverArtifact } = await import("../../../src/agents/agent-tools/state.js");

describe("deliverArtifact HITL gating (src/agents/agent-tools/state.ts)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("propagates GraphInterrupt thrown by hitlGate without swallowing it in try/catch", async () => {
    class GraphInterrupt extends Error {
      constructor(public interrupts: unknown[]) {
        super("GraphInterrupt");
        this.name = "GraphInterrupt";
      }
    }

    const graphInterruptInstance = new GraphInterrupt([{ value: "approval" }]);
    mockHitlGate.mockRejectedValueOnce(graphInterruptInstance);

    await expect(
      deliverArtifact.invoke({ path: "/data/artifacts/report.csv" }),
    ).rejects.toThrow(graphInterruptInstance);

    expect(mockHitlGate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "deliver_artifact",
        args: { path: "/data/artifacts/report.csv" },
      }),
      expect.anything(),
    );
    expect(mockDeliverArtifactFile).not.toHaveBeenCalled();
  });

  it("returns rejection message if hitlGate returns a rejection string", async () => {
    mockHitlGate.mockResolvedValueOnce("❌ Rejected by founder.");

    const res = await deliverArtifact.invoke({ path: "/data/artifacts/report.csv" });

    expect(res).toBe("❌ Rejected by founder.");
    expect(mockDeliverArtifactFile).not.toHaveBeenCalled();
  });

  it("delivers file if hitlGate approves (returns null/falsy)", async () => {
    mockHitlGate.mockResolvedValueOnce(null);
    mockDeliverArtifactFile.mockResolvedValueOnce({
      filename: "report.csv",
      bytes: 1234,
    });

    const res = await deliverArtifact.invoke({
      path: "/data/artifacts/report.csv",
      caption: "Monthly Report",
    });

    expect(res).toContain('✅ Artifact "report.csv" (1234 bytes) delivered successfully to Telegram.');
    expect(mockDeliverArtifactFile).toHaveBeenCalledWith({
      path: "/data/artifacts/report.csv",
      caption: "Monthly Report",
    });
  });

  it("catches side-effect errors during deliverArtifactFile execution after approval", async () => {
    mockHitlGate.mockResolvedValueOnce(null);
    mockDeliverArtifactFile.mockRejectedValueOnce(new Error("File not found or 0 bytes"));

    const res = await deliverArtifact.invoke({ path: "/data/artifacts/report.csv" });

    expect(res).toBe("❌ Failed to deliver artifact: File not found or 0 bytes");
    expect(mockDeliverArtifactFile).toHaveBeenCalledWith({
      path: "/data/artifacts/report.csv",
      caption: undefined,
    });
  });
});
