/**
 * WorkspaceHandle contract tests (spec 2026-07-14 §3.2, follow-up item 10).
 * The run_id grammar is a security boundary (path/S3-key segment) — these
 * tests pin that traversal-shaped ids can never validate.
 */

import { describe, it, expect } from "vitest";
import { WorkspaceHandleSchema, RUN_ID_RE } from "../../../src/kernel/workspace.js";

const VALID = {
  run_id: "run-a1b2c3d4e5f6",
  kind: "vps-docker",
  local_dir: "/work",
  s3_prefix: "agent-runs/run-a1b2c3d4e5f6",
  expires_at: "2026-07-14T12:00:00.000Z",
};

describe("WorkspaceHandleSchema", () => {
  it("accepts a well-formed vps-docker handle", () => {
    const parsed = WorkspaceHandleSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
  });

  it("accepts the mac-projects kind", () => {
    expect(WorkspaceHandleSchema.safeParse({ ...VALID, kind: "mac-projects" }).success).toBe(true);
  });

  it("rejects unknown workspace kinds", () => {
    expect(WorkspaceHandleSchema.safeParse({ ...VALID, kind: "shared-nfs" }).success).toBe(false);
  });

  it("rejects a non-datetime expires_at", () => {
    expect(WorkspaceHandleSchema.safeParse({ ...VALID, expires_at: "tomorrow" }).success).toBe(false);
  });

  it.each([
    "../../root/founderos", // traversal
    "run_id.with.dots",
    "run/with/slash",
    "UPPER-case",
    "ab", // too short
    "-leading-hyphen",
    "trailing-hyphen-",
    "a".repeat(65), // too long
    "",
  ])("rejects traversal-shaped / malformed run_id %j", (runId) => {
    expect(RUN_ID_RE.test(runId)).toBe(false);
    expect(WorkspaceHandleSchema.safeParse({ ...VALID, run_id: runId }).success).toBe(false);
  });

  it.each(["run-abc1", "gap-scan-2026-07-14", "a1b2", "run-" + "x".repeat(59)])(
    "accepts well-formed run_id %j",
    (runId) => {
      expect(RUN_ID_RE.test(runId)).toBe(true);
      expect(WorkspaceHandleSchema.safeParse({ ...VALID, run_id: runId }).success).toBe(true);
    },
  );
});
