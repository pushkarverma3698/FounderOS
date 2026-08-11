/**
 * brain:sync stale-section withholding — unit tests for the pure logic.
 *
 * A doc's "DO NOT FOLLOW" banner protects a human reader, who sees the whole
 * file. It does not protect a retrieval consumer, who sees ONE 1800-char chunk.
 * These tests pin the mechanism that keeps v2 procedure out of the brain, and —
 * most importantly — that a renamed heading FAILS the sync instead of silently
 * re-admitting the procedure it was meant to withhold.
 */

import { describe, it, expect } from "vitest";
import { stripStaleSections, STALE_SECTIONS } from "../../../scripts/sync-turicks-brain.js";

const DOC = "docs/rules/PROGRAMMING-RULES.md";
const STALE_HEADING = "## Wiring Map 2 — Add a Department";

describe("stripStaleSections", () => {
  it("returns content unchanged for a source with no stale sections", () => {
    const content = "# Anything\n\nBody text.";

    expect(stripStaleSections(content, "docs/decisions/001-why-langgraph.md")).toBe(content);
  });

  it("drops the stale section body but keeps its heading and later sections", () => {
    const content = [
      "# Programming Rules",
      "",
      "## Wiring Map 1 — Add a Tool",
      "Add the tool to DEPARTMENT_TOOLS in capabilities.ts.",
      "",
      STALE_HEADING,
      "Add the agent to the createSupervisor({ agents: [...] }) array in office.ts.",
      "",
      "## Wiring Map 3 — Add a Workflow (SOP)",
      "Register a WorkflowDef in src/workflows/registry.ts.",
      "",
      "## Path & Import Rules (project-wide)",
      "Always use .js extensions.",
    ].join("\n");

    const out = stripStaleSections(content, DOC);

    // The tombstoned procedure is gone…
    expect(out).not.toContain("createSupervisor");
    expect(out).not.toContain("office.ts");
    expect(out).not.toContain("src/workflows/registry.ts");
    // …but the headings survive, so a reader of a neighbouring chunk sees the gap…
    expect(out).toContain(STALE_HEADING);
    expect(out).toContain("_(v2 procedure — withheld from retrieval");
    // …and current sections on both sides are untouched.
    expect(out).toContain("Add the tool to DEPARTMENT_TOOLS in capabilities.ts.");
    expect(out).toContain("Always use .js extensions.");
  });

  it("collapses a dropped body to a single marker line, not one per line", () => {
    const content = [
      STALE_HEADING,
      "line one",
      "line two",
      "line three",
      "## Wiring Map 3 — Add a Workflow (SOP)",
      "registry line",
      "## Next",
    ].join("\n");

    const out = stripStaleSections(content, DOC);

    // One marker per dropped section, not one per dropped line.
    expect(out.match(/withheld from retrieval/g)).toHaveLength(2);
  });

  it("drops a trailing stale section that runs to end-of-file", () => {
    const content = [
      "# Top",
      "",
      STALE_HEADING,
      "map 2 body",
      "## Wiring Map 3 — Add a Workflow (SOP)",
      "trailing office.ts procedure",
    ].join("\n");

    const out = stripStaleSections(content, DOC);

    expect(out).not.toContain("office.ts");
    expect(out).toContain("## Wiring Map 3 — Add a Workflow (SOP)");
  });

  it("does not stop at a deeper sub-heading inside the stale section", () => {
    const content = [
      STALE_HEADING,
      "### Forget → Error table",
      "office.ts import fails",
      "## Wiring Map 3 — Add a Workflow (SOP)",
      "kept",
    ].join("\n");

    const out = stripStaleSections(content, DOC);

    expect(out).not.toContain("Forget → Error table");
    expect(out).not.toContain("office.ts import fails");
  });

  it("THROWS when a listed heading is missing — a rename must fail loudly", () => {
    const renamed = ["# Programming Rules", "", "## Wiring Map 2 — Departments (v3)", "new text"].join(
      "\n",
    );

    expect(() => stripStaleSections(renamed, DOC)).toThrow(/stale-section heading .* not found/);
  });
});

describe("STALE_SECTIONS manifest", () => {
  it("covers the two guides that still carry v2 procedure", () => {
    expect(Object.keys(STALE_SECTIONS).sort()).toEqual([
      "docs/DEVELOPER.md",
      "docs/rules/PROGRAMMING-RULES.md",
    ]);
  });
});
