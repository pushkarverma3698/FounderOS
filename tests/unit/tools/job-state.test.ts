/**
 * Unit tests for `job_state` tool and `queryJobState` helper.
 */

import { describe, it, expect, vi } from "vitest";
import { jobStateTool } from "../../../src/tools/job-state.js";
import { queryJobState } from "../../../src/db/job-queries.js";

vi.mock("../../../src/db/job-queries.js", () => ({
  queryJobState: vi.fn().mockResolvedValue({ count: 5, total: 10, rows: [{}, {}, {}, {}, {}] })
}));

describe("job_state tool & queryJobState", () => {
  it("defines read-only metadata and input schema", () => {
    expect(jobStateTool.name).toBe("job_state");
    expect(jobStateTool.description).toContain("Deterministic read of captured job applications");
    const props = jobStateTool.input_schema?.properties as Record<string, unknown> | undefined;
    expect(props).toHaveProperty("stage");
    expect(props).toHaveProperty("section");
    expect(props).toHaveProperty("applied");
    expect(props).toHaveProperty("fullDetails");
  });

  it("queries job state returning count, total, and rows", async () => {
    const res = await queryJobState({ limit: 10 });
    expect(typeof res.count).toBe("number");
    expect(typeof res.total).toBe("number");
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it("tool execution returns valid JSON response envelope", async () => {
    const res = await jobStateTool.execute({ limit: 5 });
    expect(res.success).toBe(true);
    if (res.success && typeof res.data === "string") {
      const parsed = JSON.parse(res.data);
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("total");
      expect(parsed).toHaveProperty("rows");
    }
  });
});
