// tests/unit/log-review/harvest.test.ts
import { describe, it, expect } from "vitest";
import { assembleDigest, renderSummary } from "../../../scripts/log-review/harvest.js";

describe("assembleDigest", () => {
  it("builds a digest from raw log text + state findings", async () => {
    const raw = [
      `{"level":50,"time":1,"turnId":"A","msg":"crash"}`,
      `{"level":30,"time":2,"turnId":"A","seam":"turn.out","inputTokens":100,"usd":0.01,"ms":500}`,
    ].join("\n");
    const digest = assembleDigest(raw, [], 7);
    expect(digest.counts.turns).toBe(1);
    expect(digest.hardAnomalies.some((a) => a.type === "error")).toBe(true);
  });

  it("renders a plaintext summary with counts", () => {
    const raw = `{"level":30,"time":1,"turnId":"A","seam":"turn.out","usd":0.01,"ms":100}`;
    const digest = assembleDigest(raw, [], 7);
    const text = renderSummary(digest);
    expect(text).toContain("turns");
    expect(text).toMatch(/hard anomalies/i);
  });
});
