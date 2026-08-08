/**
 * Regression: `synthesize_skill` authors AND compiles TypeScript into the
 * running application's own source tree (`src/tools/custom`). The 2026-08-08
 * audit (F-07) found it live on prod, offered to the admin and engineering
 * workers, and absent from HITL_GATED_TOOLS — meaning a model could turn its
 * own output into an executable production capability with nobody approving it.
 *
 * Two independent locks, one test each:
 *   1. SKILL_SYNTHESIS_ENABLED off  → the tool is never OFFERED to a worker.
 *   2. even when offered            → it is HITL-gated, so no unattended write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildWorkerSpecs } from "../../../src/gateway/kernel-boot.js";
import { HITL_GATED_TOOLS } from "../../../src/agents/capabilities.js";

function toolNamesFor(workerId: string): string[] {
  const w = buildWorkerSpecs().find((s) => s.id === workerId);
  return (w?.tools ?? []).map((t) => (t as { name?: string }).name ?? "");
}

describe("synthesize_skill — production safety gate", () => {
  const original = process.env["SKILL_SYNTHESIS_ENABLED"];
  beforeEach(() => {
    delete process.env["SKILL_SYNTHESIS_ENABLED"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["SKILL_SYNTHESIS_ENABLED"];
    else process.env["SKILL_SYNTHESIS_ENABLED"] = original;
  });

  it("is withheld from every worker when the flag is unset (the default)", () => {
    for (const worker of ["admin", "engineering"]) {
      expect(toolNamesFor(worker)).not.toContain("synthesize_skill");
    }
  });

  it("is withheld when the flag is explicitly false", () => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "false";
    expect(toolNamesFor("engineering")).not.toContain("synthesize_skill");
  });

  it("is offered only when the flag is explicitly true", () => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "true";
    expect(toolNamesFor("engineering")).toContain("synthesize_skill");
  });

  it("is HITL-gated, so enabling the flag still never means an unattended code write", () => {
    expect(HITL_GATED_TOOLS.has("synthesize_skill")).toBe(true);
  });
});
