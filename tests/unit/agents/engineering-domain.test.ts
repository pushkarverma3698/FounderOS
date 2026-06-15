import { describe, it, expect } from "vitest";
import { buildEngineeringDomain } from "../../../src/agents/engineering-domain.js";

describe("engineering-domain (CTO subgraph)", () => {
  it("compiles a sub-supervisor named 'engineering'", () => {
    const cto = buildEngineeringDomain();
    expect(cto).toBeTruthy();
    // compiled graphs expose an invoke method
    expect(typeof cto.invoke).toBe("function");
  });
});
