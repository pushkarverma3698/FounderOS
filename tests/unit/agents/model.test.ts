/**
 * Unit tests for the office model factory.
 *
 * Determinism rule: routing and tool-calling must be reproducible so the eval
 * harness scores the same behaviour run-to-run. That means temperature 0 by
 * default. RED until getModel() pins temperature to 0 (it currently uses 0.3).
 */

import { describe, it, expect, afterEach } from "vitest";
import { getModel } from "../../../src/agents/model.js";

describe("getModel temperature (determinism)", () => {
  afterEach(() => {
    delete process.env["AGENT_TEMPERATURE"];
  });

  it("defaults to temperature 0 for deterministic routing/tool-calling", () => {
    delete process.env["AGENT_TEMPERATURE"];
    expect(getModel().temperature).toBe(0);
  });

  it("honours a numeric AGENT_TEMPERATURE override (e.g. creative content runs)", () => {
    process.env["AGENT_TEMPERATURE"] = "0.7";
    expect(getModel().temperature).toBe(0.7);
  });

  it("falls back to 0 when AGENT_TEMPERATURE is non-numeric", () => {
    process.env["AGENT_TEMPERATURE"] = "not-a-number";
    expect(getModel().temperature).toBe(0);
  });
});
