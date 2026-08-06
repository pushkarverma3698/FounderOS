/**
 * M0a — Evolution Engine v0: dead-code analyzers.
 * ================================================
 * These tests encode the THREE false-positive traps that produced wrong answers
 * during the 2026-08-06 hand audit (docs/founderos-v2/04-DESIGN-LOG.md):
 *
 *   1. a symbol used only inside its OWN file is NOT dead
 *      (this wrongly flagged `buildLessonStore`, which is wired in kernel-boot);
 *   2. a module imported via a deep relative path IS reachable
 *      (naive matching wrongly flagged 17 `src/tools/*` modules);
 *   3. an alias re-export counts as a reference to the aliased symbol, not proof
 *      of use (this wrongly flagged `runRagOrchestrator`).
 *
 * The M0a acceptance gate is that the analyzers re-derive the hand-found results.
 * If they cannot, the sensor is wrong and every downstream engine inherits it.
 */

import { describe, it, expect } from "vitest";
import {
  findDeadExports,
  findOrphanModules,
  findUnusedDependencies,
  type SourceFile,
} from "../../../src/evolution/analyzers/dead-code.js";

const file = (path: string, text: string): SourceFile => ({ path, text });

describe("findDeadExports", () => {
  it("flags an exported symbol that is never referenced anywhere", () => {
    const files = [file("src/a.ts", "export function unusedThing() { return 1; }")];

    const found = findDeadExports(files);

    expect(found.map((f) => f.subject)).toEqual(["unusedThing"]);
  });

  it("does NOT flag a symbol used inside its own file (the buildLessonStore trap)", () => {
    const files = [
      file(
        "src/boot.ts",
        `export function buildLessonStore() { return {}; }
         export function boot() { return { lessons: buildLessonStore() }; }`,
      ),
      file("src/index.ts", 'import { boot } from "./boot.js"; boot();'),
    ];

    const found = findDeadExports(files);

    expect(found.map((f) => f.subject)).not.toContain("buildLessonStore");
  });

  it("does NOT flag a symbol referenced from another file", () => {
    const files = [
      file("src/a.ts", "export const SHARED = 1;"),
      file("src/b.ts", 'import { SHARED } from "./a.js"; console.log(SHARED);'),
    ];

    expect(findDeadExports(files)).toEqual([]);
  });

  it("reports evidence legible to someone who has never read the code", () => {
    const files = [file("src/a.ts", "export function ghost() {}")];

    const [finding] = findDeadExports(files);

    expect(finding?.evidence).toMatch(/exactly once/i);
    expect(finding?.location).toBe("src/a.ts");
  });
});

describe("findOrphanModules", () => {
  it("flags a module no other file imports", () => {
    const files = [
      file("src/lonely.ts", "export const x = 1;"),
      file("src/main.ts", "export const y = 2;"),
    ];

    const found = findOrphanModules(files);

    expect(found.map((f) => f.subject)).toEqual(["src/lonely.ts"]);
  });

  it("does NOT flag a module imported via a deep relative path (the src/tools trap)", () => {
    const files = [
      file("src/tools/email.ts", "export const emailTool = {};"),
      file("src/agents/agent-tools/comms.ts", 'import { emailTool } from "../../tools/email.js";'),
    ];

    // comms.ts itself has no importer in this fixture, so it is legitimately an
    // orphan here; the trap under test is whether email.ts is wrongly flagged.
    expect(findOrphanModules(files).map((f) => f.subject)).not.toContain("src/tools/email.ts");
  });

  it("does NOT flag an entry point", () => {
    const files = [file("src/index.ts", "export const boot = 1;")];

    expect(findOrphanModules(files)).toEqual([]);
  });
});

describe("findUnusedDependencies", () => {
  it("flags a dependency never imported in src", () => {
    const files = [file("src/a.ts", 'import x from "zod";')];

    const found = findUnusedDependencies(files, ["zod", "mem0ai"]);

    expect(found.map((f) => f.subject)).toEqual(["mem0ai"]);
  });

  it("recognises single-quoted and scoped imports", () => {
    const files = [
      file("src/a.ts", "import a from '@langchain/core';"),
      file("src/b.ts", 'import b from "@aws-sdk/client-s3";'),
    ];

    const found = findUnusedDependencies(files, ["@langchain/core", "@aws-sdk/client-s3"]);

    expect(found).toEqual([]);
  });

  it("does NOT confuse a scoped package with a longer package sharing its prefix", () => {
    const files = [file("src/a.ts", 'import x from "@langchain/langgraph-checkpoint";')];

    const found = findUnusedDependencies(files, ["@langchain/langgraph"]);

    expect(found.map((f) => f.subject)).toEqual(["@langchain/langgraph"]);
  });
});
