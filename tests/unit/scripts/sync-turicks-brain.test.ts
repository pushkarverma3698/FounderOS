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
import {
  stripStaleSections,
  STALE_SECTIONS,
  contentSha,
  needsChunkRefresh,
  isPlanSyncSource,
  PLAN_SYNC_DIRS,
  isSessionLogFile,
} from "../../../scripts/sync-turicks-brain.js";
import { missingEnvFileMessage, missingVarMessage } from "../../../scripts/lib/require-env.js";

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

/**
 * The re-embed decision. Every sync used to re-embed every chunk of every doc,
 * changed or not — ~1.1s per chunk on the VPS, ~10 minutes for a no-op run, which
 * exceeded the deploy's SSH budget and got the remote script killed mid-flight
 * (2026-08-12). These pin the skip, and — the case that actually matters — pin
 * that a PARTIALLY written source is never mistaken for a current one.
 */
describe("needsChunkRefresh", () => {
  it("skips when every expected chunk is already stored under this content's sha", () => {
    expect(needsChunkRefresh(7, 7)).toBe(false);
  });

  it("refreshes when the source has no chunks under this sha (content changed, or first sync)", () => {
    expect(needsChunkRefresh(0, 7)).toBe(true);
  });

  it("refreshes a PARTIAL write — a killed run leaves fewer rows than the content needs", () => {
    expect(needsChunkRefresh(3, 7)).toBe(true);
  });

  it("refreshes when more rows match than expected (chunker settings changed)", () => {
    expect(needsChunkRefresh(9, 7)).toBe(true);
  });

  it("has nothing to do for empty content", () => {
    expect(needsChunkRefresh(0, 0)).toBe(false);
  });
});

describe("contentSha", () => {
  it("is stable for identical content, so an unchanged doc keeps matching its stored chunks", () => {
    expect(contentSha("# Doc\n\nbody")).toBe(contentSha("# Doc\n\nbody"));
  });

  it("changes on any edit, so a changed doc always re-embeds", () => {
    expect(contentSha("# Doc\n\nbody")).not.toBe(contentSha("# Doc\n\nbody."));
  });
});

/**
 * Pins the fix for the 2026-08-08 gap this file's own header comment
 * documents (scripts/sync-turicks-brain.ts:308-311): docs/plans and
 * docs/product-recovery were absent from the sync allowlist, so `brain:sync`
 * reported success while ingesting zero plans. This exercises the allowlist
 * predicate directly — no Postgres/Ollama required — so a future regression
 * (e.g. a rename that drops a dir from PLAN_SYNC_DIRS) fails a fast unit test
 * instead of only showing up as a silent zero-plans sync in production.
 */
describe("isPlanSyncSource", () => {
  it("accepts a docs/plans/*.md path — the exact case this allowlist exists for", () => {
    expect(isPlanSyncSource("docs/plans/2026-08-12-self-improvement-audit.md")).toBe(true);
  });

  it("accepts a docs/product-recovery/*.md path (the other allowlisted dir)", () => {
    expect(isPlanSyncSource("docs/product-recovery/12-FAILURE-LEDGER.md")).toBe(true);
  });

  it("rejects a non-.md file in an allowlisted dir", () => {
    expect(isPlanSyncSource("docs/plans/notes.txt")).toBe(false);
  });

  it("rejects a .md file outside both allowlisted dirs", () => {
    expect(isPlanSyncSource("docs/decisions/001-why-langgraph.md")).toBe(false);
  });

  it("rejects a nested .md file — collectDocs' readdirSync is non-recursive", () => {
    expect(isPlanSyncSource("docs/plans/sub/nested.md")).toBe(false);
  });

  it("PLAN_SYNC_DIRS still lists exactly the two directories this test covers", () => {
    expect([...PLAN_SYNC_DIRS].sort()).toEqual(["docs/plans", "docs/product-recovery"]);
  });
});

/**
 * TEMPLATE.md (docs/sessions/TEMPLATE.md) is the empty scaffold real session
 * logs are authored from — `f.endsWith(".md")` alone would ingest it as a
 * blank "session" knowledge entry on every brain:sync. This predicate is what
 * the sessions walker filters on (scripts/sync-turicks-brain.ts).
 */
describe("isSessionLogFile", () => {
  it("accepts a real session log", () => {
    expect(isSessionLogFile("2026-08-25-rag-pipeline-upgrade.md")).toBe(true);
  });

  it("rejects TEMPLATE.md specifically", () => {
    expect(isSessionLogFile("TEMPLATE.md")).toBe(false);
  });

  it("rejects a non-.md file", () => {
    expect(isSessionLogFile("notes.txt")).toBe(false);
  });
});

/**
 * brain:sync used to fail with a bare `node: .env: not found` (missing file)
 * or an opaque zod stack trace (file present, DATABASE_URL unset) — see
 * scripts/lib/require-env.ts's header comment. These pin the two messages by
 * name; the CLI-only guard itself is exercised in the PR's manual
 * verification (it must not fire on import, or every test in this file that
 * imports sync-turicks-brain.js would exit(1) before running).
 */
describe("require-env messages", () => {
  it("names the missing .env file and the fix", () => {
    const msg = missingEnvFileMessage("/repo/.env");
    expect(msg).toContain("/repo/.env not found");
    expect(msg).toContain("cp .env.example .env");
  });

  it("names the missing variable and the fix", () => {
    const msg = missingVarMessage("DATABASE_URL");
    expect(msg).toContain("DATABASE_URL is not set");
    expect(msg).toContain(".env.example");
  });
});
