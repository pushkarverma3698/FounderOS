import { describe, it, expect, afterEach } from "vitest";
import { getFallbackModelIds } from "../../../src/agents/model.js";

const KEYS = [
  "AGENT_FALLBACK_MODELS",
  "PLANNER_FALLBACK_MODELS",
  "WORKER_FALLBACK_MODELS",
] as const;

describe("per-role fallback pools", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("falls back to the shared AGENT_FALLBACK_MODELS chain when the role pool is unset", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "openrouter:a/one,openrouter:b/two";
    expect(getFallbackModelIds("planner")).toEqual(["openrouter:a/one", "openrouter:b/two"]);
    expect(getFallbackModelIds("worker")).toEqual(["openrouter:a/one", "openrouter:b/two"]);
    expect(getFallbackModelIds()).toEqual(["openrouter:a/one", "openrouter:b/two"]);
  });

  it("uses the role pool when set, and leaves the other role on the shared chain", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "openrouter:shared/x";
    process.env["PLANNER_FALLBACK_MODELS"] = "openrouter:plan/p1, openrouter:plan/p2";
    process.env["WORKER_FALLBACK_MODELS"] = "openrouter:work/w1";
    expect(getFallbackModelIds("planner")).toEqual(["openrouter:plan/p1", "openrouter:plan/p2"]);
    expect(getFallbackModelIds("worker")).toEqual(["openrouter:work/w1"]);
    expect(getFallbackModelIds()).toEqual(["openrouter:shared/x"]);
  });

  it("an explicitly empty role pool means no fallbacks, not the shared chain", () => {
    process.env["AGENT_FALLBACK_MODELS"] = "openrouter:shared/x";
    process.env["WORKER_FALLBACK_MODELS"] = "";
    expect(getFallbackModelIds("worker")).toEqual([]);
  });
});
