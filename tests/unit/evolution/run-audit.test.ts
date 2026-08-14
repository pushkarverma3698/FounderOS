/**
 * Task 3 — the acting loop's orchestration contract.
 * ===================================================
 * These pin the three defects that made the 3-day self-audit useless on prod
 * (docs/plans/2026-08-13-task3-acting-loop-telemetry-wiring.md):
 *
 *  - a skipped telemetry tier must be ABSENT from the persisted coverage, never
 *    present-and-empty, or every open telemetry finding gets marked "resolved";
 *  - a mis-resolved repo root must fail loudly, not report 0 findings as clean;
 *  - persistence is flag-gated and defaults OFF.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Fakes ─────────────────────────────────────────────────────────────────────

const persistFindingsForRun = vi.fn(async () => ({
  persisted: true,
  runId: "run-1",
  newCount: 0,
  recurringCount: 0,
  regressedCount: 0,
  resolvedCount: 0,
  regressed: [],
}));
vi.mock("../../../src/evolution/persist-findings.js", () => ({ persistFindingsForRun }));

const collectCostRows = vi.fn(async () => [] as unknown[]);
const collectLessonRows = vi.fn(async () => [] as unknown[]);
vi.mock("../../../src/evolution/collect-telemetry.js", () => ({ collectCostRows, collectLessonRows }));

const { runSelfAudit, persistAuditRun, TELEMETRY_ANALYZERS } = await import(
  "../../../src/evolution/run-audit.js"
);

// ── A minimal but REAL tree, so the static analyzers run for real ─────────────

let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["EVOLUTION_PERSIST_FINDINGS"];

  root = mkdtempSync(join(tmpdir(), "audit-root-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { grammy: "^1" } }));
  writeFileSync(join(root, "src", "index.ts"), `export const hello = 1;\n`);
  writeFileSync(join(root, "tests", "index.test.ts"), `import "../src/index.js";\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const STATIC_ANALYZERS = [
  "findDeadExports",
  "findOrphanModules",
  "findOrphanSubsystems",
  "findUnusedDependencies",
  "findOversizedPrompts",
  "findUntestedModules",
  "findFilesNearLocBudget",
];

describe("runSelfAudit — coverage is reported, never assumed", () => {
  it("returns every static analyzer as its own coverage entry", async () => {
    const run = await runSelfAudit(root);
    expect(run.staticResults.map((r) => r.analyzer)).toEqual(STATIC_ANALYZERS);
  });

  it("reports all three telemetry analyzers when the database answers", async () => {
    const run = await runSelfAudit(root);

    expect(run.telemetrySkippedReason).toBeNull();
    expect(run.telemetryResults.map((r) => r.analyzer)).toEqual([...TELEMETRY_ANALYZERS]);
  });

  it("on a database failure reports the reason and NO telemetry coverage at all", async () => {
    collectLessonRows.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    const run = await runSelfAudit(root);

    expect(run.telemetrySkippedReason).toContain("ECONNREFUSED");
    // The load-bearing assertion: absent, NOT present-with-zero-findings.
    expect(run.telemetryResults).toEqual([]);
  });

  it("fails loudly when the tree holds no source files instead of reporting a clean audit", async () => {
    const empty = mkdtempSync(join(tmpdir(), "audit-empty-"));
    mkdirSync(join(empty, "src"), { recursive: true });
    writeFileSync(join(empty, "package.json"), "{}");

    await expect(runSelfAudit(empty)).rejects.toThrow(/collected 0 source files/);

    rmSync(empty, { recursive: true, force: true });
  });
});

describe("persistAuditRun — flag-gated, and coverage-honest when it writes", () => {
  it("writes when the flag is unset (default ON — survives a deploy re-rendering .env)", async () => {
    const run = await runSelfAudit(root);

    const outcome = await persistAuditRun(run);

    expect(outcome.state).toBe("attempted");
    expect(persistFindingsForRun).toHaveBeenCalled();
  });

  it("opts out only on the literal string \"false\"", async () => {
    process.env["EVOLUTION_PERSIST_FINDINGS"] = "false";
    const run = await runSelfAudit(root);

    expect((await persistAuditRun(run)).state).toBe("disabled");
    expect(persistFindingsForRun).not.toHaveBeenCalled();
  });

  it("does not treat an unrecognised value as an opt-out", async () => {
    process.env["EVOLUTION_PERSIST_FINDINGS"] = "1";
    const run = await runSelfAudit(root);

    expect((await persistAuditRun(run)).state).toBe("attempted");
  });

  it("passes all ten analyzers as coverage when both tiers ran", async () => {
    process.env["EVOLUTION_PERSIST_FINDINGS"] = "true";
    const run = await runSelfAudit(root);

    await persistAuditRun(run);

    const [input] = persistFindingsForRun.mock.calls[0] as unknown as [
      { analyzerResults: Array<{ analyzer: string }>; loop: string; tenantId: string },
    ];
    expect(input.analyzerResults.map((a) => a.analyzer)).toEqual([
      ...STATIC_ANALYZERS,
      ...TELEMETRY_ANALYZERS,
    ]);
    expect(input.loop).toBe("audit");
  });

  it("EXCLUDES the telemetry analyzers from coverage when the tier was skipped", async () => {
    // The regression this test exists for: including them with `findings: []`
    // would mark every open telemetry finding `resolved` — writing "the sensor
    // was blind" into the database as "everything got fixed".
    collectCostRows.mockRejectedValueOnce(new Error("db down"));
    process.env["EVOLUTION_PERSIST_FINDINGS"] = "true";

    const run = await runSelfAudit(root);
    await persistAuditRun(run);

    const [input] = persistFindingsForRun.mock.calls[0] as unknown as [
      { analyzerResults: Array<{ analyzer: string }> },
    ];
    const names = input.analyzerResults.map((a) => a.analyzer);

    expect(names).toEqual(STATIC_ANALYZERS);
    for (const telemetry of TELEMETRY_ANALYZERS) {
      expect(names).not.toContain(telemetry);
    }
  });

  it("surfaces a store outage as an attempted-but-unpersisted run, never as success", async () => {
    process.env["EVOLUTION_PERSIST_FINDINGS"] = "true";
    persistFindingsForRun.mockResolvedValueOnce({
      persisted: false,
      runId: null,
      newCount: 0,
      recurringCount: 0,
      regressedCount: 0,
      resolvedCount: 0,
      regressed: [],
      error: "relation evolution_runs does not exist",
    } as never);

    const outcome = await persistAuditRun(await runSelfAudit(root));

    expect(outcome.state).toBe("attempted");
    expect(outcome.state === "attempted" && outcome.result.persisted).toBe(false);
  });
});
