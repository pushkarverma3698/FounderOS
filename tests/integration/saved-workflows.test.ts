/**
 * Saved-workflow catalog upsert (real Postgres).
 * Proves recordWorkflowRun inserts once per signature and that a repeat run
 * increments run_count (not a second row) — so topWorkflows can order by
 * "most used". This is the DB contract behind "find our most-used workflows".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TENANT } from "../../src/core/config.js";
import { recordWorkflowRun, topWorkflows } from "../../src/db/queries.js";
import { workflowSignature, slugifyWorkflow } from "../../src/tools/workflow-catalog.js";
import { getDb } from "../../src/db/client.js";
import { savedWorkflows } from "../../src/db/schema.js";
import { eq, like } from "drizzle-orm";

const COMMAND = `int-test-${Date.now()} node generate_svg.js`;
const SIG = workflowSignature("vps_run", COMMAND, "node:22-bookworm-slim");

describe("recordWorkflowRun (real Postgres)", () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(savedWorkflows).where(like(savedWorkflows.command, "int-test-%"));
  });

  function run(runId: string, s3Keys: string[]) {
    return recordWorkflowRun({
      tenant_id: TENANT,
      slug: slugifyWorkflow(COMMAND, "Generate the SVG"),
      signature: SIG,
      tool: "vps_run",
      command: COMMAND,
      brief: "Generate the SVG",
      image: "node:22-bookworm-slim",
      s3_keys: s3Keys,
      last_run_id: runId,
    });
  }

  it("inserts one row on first run", async () => {
    await run("run-a", ["agent-runs/run-a/x.svg"]);
    const db = getDb();
    const rows = await db.select().from(savedWorkflows).where(eq(savedWorkflows.signature, SIG));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_count).toBe(1);
    expect(rows[0]!.s3_keys).toEqual(["agent-runs/run-a/x.svg"]);
  });

  it("increments run_count on a repeat of the same signature (no duplicate row)", async () => {
    await run("run-a", ["agent-runs/run-a/x.svg"]);
    await run("run-b", ["agent-runs/run-b/x.svg"]);
    const db = getDb();
    const rows = await db.select().from(savedWorkflows).where(eq(savedWorkflows.signature, SIG));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_count).toBe(2);
    expect(rows[0]!.last_run_id).toBe("run-b");
    expect(rows[0]!.s3_keys).toEqual(["agent-runs/run-b/x.svg"]);
  });

  it("surfaces the workflow in topWorkflows for the tenant", async () => {
    await run("run-a", []);
    const top = await topWorkflows(TENANT, 50);
    expect(top.some((w) => w.signature === SIG)).toBe(true);
  });
});
