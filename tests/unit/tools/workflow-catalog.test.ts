/**
 * Pure helpers for the saved-workflow catalog: deterministic slug + signature so
 * the same script always dedupes to one row (run_count increments) and gets a
 * human-readable, S3-safe name.
 */
import { describe, it, expect } from "vitest";
import { slugifyWorkflow, workflowSignature } from "../../../src/tools/workflow-catalog.js";

describe("slugifyWorkflow", () => {
  it("prefers the brief's first line, kebab-cased and capped", () => {
    expect(slugifyWorkflow("node build.js", "Generate the weekly SVG report")).toBe("generate-the-weekly-svg-report");
  });

  it("falls back to the command when no brief", () => {
    expect(slugifyWorkflow("node generate_svg.js", undefined)).toBe("node-generate-svg-js");
  });

  it("strips unsafe characters and collapses separators", () => {
    expect(slugifyWorkflow("  Foo / Bar!!  Baz  ", undefined)).toBe("foo-bar-baz");
  });

  it("caps length and never leaves a trailing hyphen", () => {
    const slug = slugifyWorkflow("x".repeat(200), undefined);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("never returns empty — falls back to 'workflow'", () => {
    expect(slugifyWorkflow("!!!", "***")).toBe("workflow");
  });
});

describe("workflowSignature", () => {
  it("is stable for identical inputs", () => {
    const a = workflowSignature("vps_run", "node x.js", "node:22-bookworm-slim");
    const b = workflowSignature("vps_run", "node x.js", "node:22-bookworm-slim");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when tool, command, or image differ", () => {
    const base = workflowSignature("vps_run", "node x.js", "node:22-bookworm-slim");
    expect(workflowSignature("claude_code", "node x.js", "node:22-bookworm-slim")).not.toBe(base);
    expect(workflowSignature("vps_run", "node y.js", "node:22-bookworm-slim")).not.toBe(base);
    expect(workflowSignature("vps_run", "node x.js", "python:3.12-slim")).not.toBe(base);
  });

  it("treats missing image the same regardless of undefined vs empty", () => {
    expect(workflowSignature("claude_code", "task")).toBe(workflowSignature("claude_code", "task", undefined));
  });
});
