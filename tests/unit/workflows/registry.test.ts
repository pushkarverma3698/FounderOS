/**
 * TDD — Workflow Registry + pure functions
 * RED before any implementation exists.
 */

import { describe, it, expect } from "vitest";
import { getWorkflow, listWorkflows, renderTemplate, parseRunArgs } from "../../../src/workflows/registry.js";

describe("getWorkflow", () => {
  it("returns onboarding workflow by id", () => {
    const wf = getWorkflow("onboarding");
    expect(wf).toBeDefined();
    expect(wf!.id).toBe("onboarding");
    expect(wf!.params).toContain("company");
    expect(wf!.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("returns outbound workflow by id", () => {
    const wf = getWorkflow("outbound");
    expect(wf).toBeDefined();
    expect(wf!.id).toBe("outbound");
  });

  it("returns undefined for unknown id", () => {
    expect(getWorkflow("nonexistent")).toBeUndefined();
  });
});

describe("listWorkflows", () => {
  it("returns at least 2 workflows", () => {
    expect(listWorkflows().length).toBeGreaterThanOrEqual(2);
  });

  it("each workflow has id, name, description, params, steps", () => {
    for (const wf of listWorkflows()) {
      expect(wf.id).toBeTruthy();
      expect(wf.name).toBeTruthy();
      expect(wf.description).toBeTruthy();
      expect(Array.isArray(wf.params)).toBe(true);
      expect(Array.isArray(wf.steps)).toBe(true);
      expect(wf.steps.length).toBeGreaterThan(0);
    }
  });
});

describe("renderTemplate", () => {
  it("replaces {company} slot", () => {
    const result = renderTemplate("Score {company} against ICP", { company: "Acme" });
    expect(result).toBe("Score Acme against ICP");
  });

  it("replaces multiple occurrences of the same slot", () => {
    const result = renderTemplate("Research {company} — find {company}'s pain points", { company: "Stripe" });
    expect(result).toBe("Research Stripe — find Stripe's pain points");
  });

  it("replaces multiple different slots", () => {
    const result = renderTemplate("Email {name} at {company}", { name: "Alice", company: "Acme" });
    expect(result).toBe("Email Alice at Acme");
  });

  it("leaves unknown slots intact", () => {
    const result = renderTemplate("Research {company} for {unknown}", { company: "Acme" });
    expect(result).toBe("Research Acme for {unknown}");
  });

  it("handles empty params gracefully", () => {
    const result = renderTemplate("Say hello", {});
    expect(result).toBe("Say hello");
  });
});

describe("parseRunArgs", () => {
  it("parses 'onboarding company=Acme Corp'", () => {
    const result = parseRunArgs("onboarding company=Acme Corp");
    expect(result).toEqual({ id: "onboarding", params: { company: "Acme Corp" } });
  });

  it("parses multiple params 'outbound company=Stripe target=founders'", () => {
    const result = parseRunArgs("outbound company=Stripe target=founders");
    expect(result).toEqual({ id: "outbound", params: { company: "Stripe", target: "founders" } });
  });

  it("handles workflow id only with no params", () => {
    const result = parseRunArgs("workflows");
    expect(result).toEqual({ id: "workflows", params: {} });
  });

  it("handles quoted values with spaces", () => {
    const result = parseRunArgs('onboarding company="Acme Beta Ltd"');
    expect(result).toEqual({ id: "onboarding", params: { company: "Acme Beta Ltd" } });
  });

  it("returns null for empty input", () => {
    expect(parseRunArgs("")).toBeNull();
  });

  it("handles a value containing '=' (e.g. a URL or token with embedded =)", () => {
    // company=acme=corp should give { company: "acme=corp" }, not split on the second =
    const result = parseRunArgs("test token=abc=def");
    expect(result).toEqual({ id: "test", params: { token: "abc=def" } });
  });
});
