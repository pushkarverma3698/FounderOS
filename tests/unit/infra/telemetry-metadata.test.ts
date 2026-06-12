import { describe, it, expect } from "vitest";
import { buildRunMetadata } from "../../../src/infra/telemetry.js";

describe("buildRunMetadata", () => {
  it("includes prompt_hash when provided", () => {
    const m = buildRunMetadata({ tenant_id: "turicks", trace_id: "t1", prompt_hash: "deadbeef0000" });
    expect(m["prompt_hash"]).toBe("deadbeef0000");
    expect(m["trace_id"]).toBe("t1");
  });

  it("omits prompt_hash gracefully when absent", () => {
    const m = buildRunMetadata({ tenant_id: "turicks", trace_id: "t1" });
    expect(m["prompt_hash"]).toBe("none");
  });
});
