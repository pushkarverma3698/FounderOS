/**
 * Unit tests for `ops_state` tool and `queryOpsState` helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsStateTool } from "../../../src/tools/ops-state.js";
import { opsState } from "../../../src/agents/agent-tools/state.js";
import { queryOpsState } from "../../../src/db/queries.js";

vi.mock("../../../src/db/queries.js", async (importOriginal) => {
  const { mockQueriesModule } = await import("../../helpers/mock-db.js");
  return mockQueriesModule();
});

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
      "job_runs",
      "background_jobs",
    ]);
  });

  it("points a spend question at the costs scope, and sweep counts at job_runs", () => {
    // Reality Benchmark A5: the agent asked for 'costs' and got sweep throughput,
    // so it truthfully reported no cost data while ai_call_costs held the spend.
    expect(opsStateTool.description).toContain("money spent on AI calls");
    expect(opsStateTool.description).toContain("job sweep throughput");
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

// "What's running?": the scope reads the files the VPS daemons leave in ~/.claude, with no database in the path.
describe("ops_state scope background_jobs", () => {
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env["HOME"];
    home = mkdtempSync(join(tmpdir(), "ops-state-bg-"));
    mkdirSync(join(home, ".claude"));
    process.env["HOME"] = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const written = () => Math.floor(Date.now() / 1000);

  it("answers from the daemons' reports, in the { count, total, scope, rows } shape plus a summary", async () => {
    writeFileSync(join(home, ".claude", "pr-brain.effective"), `written=${written()}\nengine=agy\nreviewers=model-a model-b\nmerge=1\n`);
    writeFileSync(join(home, ".claude", "agent-dispatch.effective"), `written=${written()}\nagy_model=gemini-x\nclaude_model=sonnet\n`);
    const res = await opsStateTool.execute({ scope: "background_jobs" });
    expect(res.success).toBe(true);
    const data = JSON.parse(String(res.data)) as { scope: string; count: number; total: number; summary: string; attention: string[]; rows: { name: string; state: string; detail: string }[] };
    expect(data.scope).toBe("background_jobs");
    expect(data.count).toBe(data.rows.length);
    expect(data.total).toBe(data.rows.length);
    expect(data.summary).toMatch(/^Everything is running: PR review ON, coding dispatch ON, \d+ built-in routines\./);
    expect(data.attention).toEqual([]);
    expect(data.rows[0]).toMatchObject({ name: "Automatic PR review", state: "on" });
    expect(data.rows[0]?.detail).toContain("model-a, then model-b");
    expect(res.observed?.evidence).toContain("scope:background_jobs");
  });

  it("an off switch is reported as off, with the way back", async () => {
    writeFileSync(join(home, ".claude", "pr-brain.off"), "off\n");
    const res = await opsStateTool.execute({ scope: "background_jobs" });
    const data = JSON.parse(String(res.data)) as { attention: string[] };
    expect(data.attention).toEqual(["PR review is OFF: agent PRs wait for you. /review on turns it back on."]);
  });
});

describe("ops_state agent tool", () => {
  it("accepts the background_jobs scope the worker is told about", () => {
    expect(opsState.schema.safeParse({ scope: "background_jobs" }).success).toBe(true);
    expect(opsState.schema.safeParse({ scope: "nonsense" }).success).toBe(false);
  });
});
