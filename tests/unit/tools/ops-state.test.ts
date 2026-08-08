/**
 * Unit tests for `ops_state` tool and `queryOpsState` helper.
 */

import { describe, it, expect } from "vitest";
import { opsStateTool, queryOpsState } from "../../../src/tools/ops-state.js";

describe("ops_state tool & queryOpsState", () => {
  it("defines input schema and scopes", () => {
    expect(opsStateTool.name).toBe("ops_state");
    expect(opsStateTool.description).toContain("Deterministic read of system operational state");
    const scopeProp = (opsStateTool.input_schema?.properties as Record<string, { enum?: string[] }> | undefined)?.["scope"];
    expect(scopeProp?.enum).toEqual([
      "scheduled_tasks",
      "reminders",
      "hitl_approvals",
      "action_log",
      "costs",
    ]);
  });

  it("queries ops state for action_log", async () => {
    const res = await queryOpsState({ scope: "action_log", limit: 5 });
    expect(res.scope).toBe("action_log");
    expect(typeof res.count).toBe("number");
    expect(typeof res.total).toBe("number");
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it("queries ops state for hitl_approvals", async () => {
    const res = await queryOpsState({ scope: "hitl_approvals", limit: 5 });
    expect(res.scope).toBe("hitl_approvals");
    expect(typeof res.count).toBe("number");
    expect(typeof res.total).toBe("number");
  });

  it("tool execution returns valid JSON response", async () => {
    const res = await opsStateTool.execute({ scope: "scheduled_tasks", limit: 5 });
    expect(res.success).toBe(true);
    if (res.success && typeof res.data === "string") {
      const parsed = JSON.parse(res.data);
      expect(parsed.scope).toBe("scheduled_tasks");
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("total");
      expect(parsed).toHaveProperty("rows");
    }
  });

  it("fails gracefully on missing scope", async () => {
    const res = await opsStateTool.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("requires a scope argument");
  });
});
