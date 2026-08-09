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
 *
 * Lock 2 is asserted against the RUNTIME gate, not against membership in
 * HITL_GATED_TOOLS. That set has no runtime effect whatsoever — it only feeds
 * the capability manifest's `*` rendering and the wiring check — so a
 * membership assertion passes happily while the tool writes to disk ungated.
 * It did: from 2026-08-08 until the P7-B review, `synthesize_skill` sat in the
 * set with no hitlGate() call anywhere in its implementation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const mockInterrupt = vi.fn();

vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: mockInterrupt };
});

const { buildWorkerSpecs } = await import("../../../src/gateway/kernel-boot.js");
const { synthesizeSkill } = await import("../../../src/tools/skill-synthesizer.js");

function toolNamesFor(workerId: string): string[] {
  const w = buildWorkerSpecs().find((s) => s.id === workerId);
  return (w?.tools ?? []).map((t) => (t as { name?: string }).name ?? "");
}

describe("synthesize_skill — production safety gate", () => {
  const original = process.env["SKILL_SYNTHESIS_ENABLED"];
  beforeEach(() => {
    delete process.env["SKILL_SYNTHESIS_ENABLED"];
    vi.clearAllMocks();
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

  // ── Lock 2: the RUNTIME gate ───────────────────────────────────────────────

  it("asks the founder for approval before synthesizing — interrupt fires with the real action", async () => {
    mockInterrupt.mockReturnValue("rejected");

    await synthesizeSkill.invoke({
      name: "gate_probe_approved",
      description: "runtime gate probe",
      tsCode: "export const probe = 1;\n",
    });

    expect(mockInterrupt).toHaveBeenCalledOnce();
    expect(mockInterrupt.mock.calls[0]?.[0]).toMatchObject({
      kind: "approval",
      action: "synthesize_skill",
    });
  });

  it("rejection writes NOTHING to the source tree — the gate precedes the first fs write", async () => {
    mockInterrupt.mockReturnValue("rejected");
    const toolPath = path.resolve("./src/tools/custom/gate_probe_rejected.ts");

    const result = await synthesizeSkill.invoke({
      name: "gate_probe_rejected",
      description: "runtime gate probe",
      tsCode: "export const probe = 1;\n",
    });

    expect(result).toBe("❌ Rejected by founder.");
    await expect(fs.access(toolPath)).rejects.toThrow();
  });
});
