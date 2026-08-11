/**
 * Unit tests for `ops_state` tool and `queryOpsState` helper.
 *
 * The database is stubbed. These tests previously called the real client, which
 * meant they asserted nothing in CI — ci.yml runs no Postgres service, so every
 * query threw and the suite went red on a connection error rather than on the
 * tool's behaviour. With a stub the returned counts are known, so the
 * assertions can be unconditional.
 */

import { describe, it, expect, vi } from "vitest";
import { createDrizzleClientStub } from "../../helpers/mock-db.js";

const stub = createDrizzleClientStub();
vi.mock("../../../src/db/client.js", () => ({ getDb: stub.getDb }));

const { opsStateTool, queryOpsState } = await import("../../../src/tools/ops-state.js");

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
    stub.setQueryResults(
      [{ total: 42 }],
      [{ id: "a1", action: "send_email" }, { id: "a2", action: "write_artifact" }],
    );

    const res = await queryOpsState({ scope: "action_log", limit: 5 });

    expect(res.scope).toBe("action_log");
    expect(res.total).toBe(42);
    expect(res.count).toBe(2);
    expect(res.rows).toHaveLength(2);
  });

  it("queries ops state for hitl_approvals", async () => {
    stub.setQueryResults([{ total: 7 }], [{ id: "h1", status: "pending" }]);

    const res = await queryOpsState({ scope: "hitl_approvals", limit: 5 });

    expect(res.scope).toBe("hitl_approvals");
    expect(res.total).toBe(7);
    expect(res.count).toBe(1);
  });

  it("reports zero rather than failing when a scope is empty", async () => {
    // An empty table and a broken query must not look alike from outside.
    stub.setQueryResults([{ total: 0 }], []);

    const res = await queryOpsState({ scope: "reminders", limit: 5 });

    expect(res.total).toBe(0);
    expect(res.count).toBe(0);
    expect(res.rows).toEqual([]);
  });

  it("tool execution returns valid JSON response", async () => {
    stub.setQueryResults([{ total: 3 }], [{ id: "s1", prompt: "sweep boards" }]);

    const res = await opsStateTool.execute({ scope: "scheduled_tasks", limit: 5 });

    expect(res.success).toBe(true);
    expect(typeof res.data).toBe("string");
    const parsed = JSON.parse(res.data as string);
    expect(parsed.scope).toBe("scheduled_tasks");
    expect(parsed.total).toBe(3);
    expect(parsed.count).toBe(1);
    expect(parsed.rows).toHaveLength(1);
  });

  it("fails gracefully on missing scope", async () => {
    const res = await opsStateTool.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("requires a scope argument");
  });
});
