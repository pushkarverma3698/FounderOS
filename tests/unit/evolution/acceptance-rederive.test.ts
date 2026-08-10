/**
 * M0a ACCEPTANCE GATE — the sensor must re-derive the hand audit.
 * ================================================================
 * docs/founderos-v2/05-RISKS-AND-GATES.md §2: the self-audit must independently
 * reproduce findings a human established on 2026-08-06. If it cannot, the sensor
 * is wrong, and the Executive, Intelligence and Evolution engines all inherit a
 * wrong measurement.
 *
 * This runs the analyzers against the REAL repository — no fixtures. It is
 * deliberately a characterization test: when one of these findings is fixed
 * (e.g. M9 deletes src/outreach), this test SHOULD fail and be updated. That is
 * the signal the amputation actually happened.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collectSourceFiles, collectDependencies } from "../../../src/evolution/collect.js";
import {
  findDeadExports,
  findOrphanModules,
  findOrphanSubsystems,
  findUnusedDependencies,
} from "../../../src/evolution/analyzers/dead-code.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const files = collectSourceFiles(ROOT);
const deps = collectDependencies(ROOT);

describe("M0a acceptance — analyzers re-derive the 2026-08-06 hand audit", () => {
  it("reads a real source tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("re-derives the dead mission API (built, zero callers)", () => {
    const dead = new Set(findDeadExports(files).map((f) => f.subject));

    // The durable-mission layer: table + lifecycle + query fns, never wired.
    expect(dead).toContain("createMission");
    expect(dead).toContain("getActiveMission");
    expect(dead).toContain("updateMissionPhase");
  });

  it("re-derives that jobhunt cannot record an application outcome", () => {
    const dead = new Set(findDeadExports(files).map((f) => f.subject));

    // 7,756 LOC of jobhunt that structurally cannot close its own loop.
    expect(dead).toContain("updateApplicationStage");
  });

  it("re-derives the unused production dependencies", () => {
    const unused = new Set(findUnusedDependencies(files, deps).map((f) => f.subject));

    expect(unused).toContain("@langchain/langgraph-supervisor");
    expect(unused).toContain("mem0ai");
    expect(unused).toContain("hono");
    expect(unused).toContain("opossum");
    expect(unused).toContain("bottleneck");
  });

  it("does NOT report dependencies that are genuinely imported", () => {
    const unused = new Set(findUnusedDependencies(files, deps).map((f) => f.subject));

    expect(unused).not.toContain("zod");
    expect(unused).not.toContain("@langchain/core");
    expect(unused).not.toContain("drizzle-orm");
  });

  it("re-derives the orphaned subsystems (cohesive internally, unreachable externally)", () => {
    const orphaned = new Set(findOrphanSubsystems(files).map((f) => f.subject));

    // src/eval and src/proof import their own modules, so file-level
    // orphan detection cannot see them — only subgraph-level detection can.
    expect(orphaned).toContain("src/eval/");
    expect(orphaned).toContain("src/proof/");
    // The kernel is obviously reachable; a sensor that flags it is broken.
    expect(orphaned).not.toContain("src/kernel/");
  });

  it("does NOT flag modules that are genuinely wired (the false-positive traps)", () => {
    const dead = new Set(findDeadExports(files).map((f) => f.subject));
    const orphans = new Set(findOrphanModules(files));

    // Wired in kernel-boot.ts — the trap that broke the first hand script.
    expect(dead).not.toContain("buildLessonStore");
    // Imported by agent-tools via deep relative paths.
    expect(orphans).not.toContain("src/tools/email.ts");
    expect(orphans).not.toContain("src/kernel/worker.ts");
  });

  it("produces evidence legible without reading the code", () => {
    const [finding] = findUnusedDependencies(files, deps);

    expect(finding?.evidence).toMatch(/never imported/i);
  });
});
