/**
 * Unit tests for Supervisor Router Jev AI System 1 gateway (src/agents/supervisor.ts).
 */
import { describe, it, expect } from "vitest";
import { evaluateSupervisorRoute, dispatch } from "../../../src/agents/supervisor.js";

describe("Supervisor Router — Jev AI System 1 Gateway Integration", () => {
  it("uses Jev AI gateway for fast System 1 deterministic routing decision", () => {
    const routeRes = evaluateSupervisorRoute({ intent: "status" });
    expect(routeRes.handled).toBe(true);
    expect(routeRes.route).toBe("system_status");
  });

  it("falls back to standard kernel dispatch when System 1 is not matched", () => {
    const routeRes = evaluateSupervisorRoute({ intent: "do complex multi step task" });
    expect(routeRes.handled).toBe(false);
  });

  it("exports kernel dispatch and supervisor utilities", () => {
    expect(typeof dispatch).toBe("function");
  });
});
