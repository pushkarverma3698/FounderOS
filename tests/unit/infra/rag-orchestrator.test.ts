import { describe, it, expect } from "vitest";
import { orchestrateRagQuery } from "../../../src/infra/rag-orchestrator.js";

describe("rag-orchestrator", () => {
  it("rejects empty query without calling tools", async () => {
    const out = await orchestrateRagQuery({ store: "research", query: "  " });
    expect(out).toMatch(/query is required/i);
  });
});
