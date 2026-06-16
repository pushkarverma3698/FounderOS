/**
 * Wiring integrity tests — the live tool registry must be fully wired.
 *
 * These guard the "half-wiring" bug class (PROGRAMMING-RULES.md): a tool added to
 * a department without a valid name/invoke, a dead HITL gate, or a tool missing
 * from the supervisor capability manifest. A structural break here = a failing
 * test = a red build, instead of a silent "I can't do that" in production.
 */

import { describe, it, expect } from "vitest";
import { checkWiring, assertWiringOrThrow, evaluateWiring } from "../../../src/infra/wiring-check.js";

const validTool = (name: string) => ({ name, invoke: () => undefined });

describe("checkWiring", () => {
  const report = checkWiring();

  it("the live registry has ZERO structural wiring errors", () => {
    // If this fails, the message lists every broken wiring so the fix is obvious.
    expect(report.errors, report.errors.join("\n")).toEqual([]);
  });

  it("assertWiringOrThrow does not throw on the current registry", () => {
    expect(() => assertWiringOrThrow()).not.toThrow();
  });

  it("returns a report with errors and warnings arrays", () => {
    expect(Array.isArray(report.errors)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it("any warnings are about prompt-mention gaps only (non-fatal)", () => {
    for (const w of report.warnings) {
      expect(w).toMatch(/prompt never mentions it/);
    }
  });
});

describe("evaluateWiring — failure paths (proves the guard actually catches breakage)", () => {
  it("flags a non-tool object wired into a department array", () => {
    const { errors } = evaluateWiring({
      departmentTools: { research: [{ name: "broken" } /* no invoke */] },
      supervisorTools: [],
      hitlGatedTools: [],
      manifest: "- research: broken",
      departmentPrompts: { research: "uses broken" },
    });
    expect(errors.some((e) => e.includes("invalid tool"))).toBe(true);
  });

  it("flags an empty department", () => {
    const { errors } = evaluateWiring({
      departmentTools: { research: [] },
      supervisorTools: [],
      hitlGatedTools: [],
      manifest: "",
      departmentPrompts: { research: "" },
    });
    expect(errors.some((e) => e.includes("no tools"))).toBe(true);
  });

  it("flags a dead HITL gate (gated tool no department carries)", () => {
    const { errors } = evaluateWiring({
      departmentTools: { comms: [validTool("send_email")] },
      supervisorTools: [],
      hitlGatedTools: ["send_email", "ghost_tool"],
      manifest: "- comms: send_email\nghost_tool",
      departmentPrompts: { comms: "send_email ghost_tool" },
    });
    expect(errors.some((e) => e.includes("ghost_tool") && e.includes("dead gate"))).toBe(true);
  });

  it("flags a wired tool missing from the capability manifest", () => {
    const { errors } = evaluateWiring({
      departmentTools: { research: [validTool("search_web")] },
      supervisorTools: [],
      hitlGatedTools: [],
      manifest: "- research: (manifest is missing the tool)",
      departmentPrompts: { research: "search_web" },
    });
    expect(errors.some((e) => e.includes("search_web") && e.includes("manifest"))).toBe(true);
  });

  it("warns when a department prompt never mentions a carried tool", () => {
    const { errors, warnings } = evaluateWiring({
      departmentTools: { research: [validTool("search_web")] },
      supervisorTools: [],
      hitlGatedTools: [],
      manifest: "- research: search_web",
      departmentPrompts: { research: "this prompt forgot the tool" },
    });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("search_web"))).toBe(true);
  });

  it("a fully-wired minimal registry has zero errors and zero warnings", () => {
    const { errors, warnings } = evaluateWiring({
      departmentTools: { comms: [validTool("send_email")] },
      supervisorTools: [validTool("read_context")],
      hitlGatedTools: ["send_email"],
      manifest: "- comms: send_email\n- supervisor: read_context",
      departmentPrompts: { comms: "call send_email to send" },
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
