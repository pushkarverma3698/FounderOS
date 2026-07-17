/**
 * Regression: an unconfigured vps_run must NOT be offered to the engineering
 * worker. Prod (2026-07-18) had VPS_RUN_HOST unset, so the planner kept picking
 * vps_run, the founder burned two HITL approvals, and it died on execute with
 * `vps-config: vps_run is not configured`. buildWorkerSpecs now gates it out
 * when resolveVpsRunConfig() returns null.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildWorkerSpecs } from "../../../src/gateway/kernel-boot.js";

function engineeringToolNames(): string[] {
  const eng = buildWorkerSpecs().find((w) => w.id === "engineering");
  return (eng?.tools ?? []).map((t) => (t as { name?: string }).name ?? "");
}

describe("buildWorkerSpecs — vps_run config gate", () => {
  const original = process.env["VPS_RUN_HOST"];
  beforeEach(() => {
    delete process.env["VPS_RUN_HOST"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["VPS_RUN_HOST"];
    else process.env["VPS_RUN_HOST"] = original;
  });

  it("omits vps_run when VPS_RUN_HOST is unset", () => {
    expect(engineeringToolNames()).not.toContain("vps_run");
  });

  it("offers vps_run when VPS_RUN_HOST is configured", () => {
    process.env["VPS_RUN_HOST"] = "founderos@127.0.0.1";
    expect(engineeringToolNames()).toContain("vps_run");
  });
});
