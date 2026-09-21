import { describe, test, expect, vi } from "vitest";
import { recoverStrandedWorkers } from "../../../src/workers/lifecycle/crash-recovery.js";
import * as queries from "../../../src/workers/db/queries.js";

describe("Worker Crash Recovery", () => {
  test("recovers stranded workers under attempt ceiling", async () => {
    vi.spyOn(queries, "reclaimStrandedWorkers").mockResolvedValueOnce({
      recovered: [
        {
          id: "row-1",
          tenant_id: "turicks",
          worker_id: "worker_recovered",
          status: "PAUSED",
          contract_version: "1.0.0",
          runtime_provider: "stub",
          runtime_id: "r1",
          failure_reason: "Reclaimed",
          recovery_attempts: "1",
          last_transition: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      failed: [],
    });

    const res = await recoverStrandedWorkers(undefined, 3);
    expect(res.recovered).toEqual(["worker_recovered"]);
    expect(res.failed).toEqual([]);
  });

  test("fails workers exceeding attempt ceiling", async () => {
    vi.spyOn(queries, "reclaimStrandedWorkers").mockResolvedValueOnce({
      recovered: [],
      failed: [
        {
          id: "row-2",
          tenant_id: "turicks",
          worker_id: "worker_failed",
          status: "FAILED",
          contract_version: "1.0.0",
          runtime_provider: "stub",
          runtime_id: "r2",
          failure_reason: "Stranded in RUNNING by crash; exceeded max recovery attempts (3)",
          recovery_attempts: "3",
          last_transition: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const res = await recoverStrandedWorkers(undefined, 3);
    expect(res.recovered).toEqual([]);
    expect(res.failed).toEqual(["worker_failed"]);
  });

  test("handles database offline gracefully (fail-open)", async () => {
    vi.spyOn(queries, "reclaimStrandedWorkers").mockRejectedValueOnce(
      new Error("ECONNREFUSED 127.0.0.1:5432"),
    );

    const res = await recoverStrandedWorkers(undefined, 3);
    expect(res.recovered).toEqual([]);
    expect(res.failed).toEqual([]);
  });
});
