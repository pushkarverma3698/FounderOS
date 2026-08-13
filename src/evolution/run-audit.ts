/**
 * Evolution Engine — the ONE self-audit orchestration path.
 * ==========================================================
 * Task 3 (docs/plans/2026-08-13-task3-acting-loop-telemetry-wiring.md).
 *
 * Before this module the CLI (`scripts/audit-self.ts`) and the cron
 * (`src/evolution/audit-sweep.ts`) were two renderers over one collector, and
 * only the CLI half was maintained: the cron dropped `skippedReason`, so a
 * telemetry tier that never ran rendered to the founder as a telemetry tier that
 * came back clean. Merging them is the fix that keeps them from drifting again —
 * both entry points now call `runSelfAudit()` here and render its result.
 *
 * Findings are returned GROUPED BY ANALYZER, never flattened. That grouping is
 * the run's coverage, and coverage is the only thing that lets
 * `persistFindingsForRun` tell "this finding is fixed" from "the analyzer that
 * finds it did not run this cycle".
 */

import { rankFindings } from "./rank.js";
import { collectDependencies, collectSourceFiles } from "./collect.js";
import {
  findDeadExports,
  findOrphanModules,
  findOrphanSubsystems,
  findUnusedDependencies,
} from "./analyzers/dead-code.js";
import {
  findFilesNearLocBudget,
  findOversizedPrompts,
  findUntestedModules,
} from "./analyzers/code-health.js";
import { persistFindingsForRun } from "./persist-findings.js";
import type { AnalyzerRunFindings, PersistFindingsResult } from "./persist-findings.js";
import type { Finding } from "./types.js";

/** Single-tenant, mirroring the private DEFAULT_TENANT in src/db/queries.ts. */
export const AUDIT_TENANT = "turicks";

/** The three analyzers that need Postgres. Named here so the skip path can say WHICH tiers went dark. */
export const TELEMETRY_ANALYZERS = [
  "findCostHotspots",
  "findRecurringFailures",
  "findUnappliedLessons",
] as const;

export interface AuditRunResult {
  /** Filesystem analyzers. Always present — they cannot be skipped. */
  readonly staticResults: readonly AnalyzerRunFindings[];
  /**
   * Database analyzers. EMPTY ARRAY when the tier was skipped — deliberately no
   * entries at all, rather than entries carrying `findings: []`. See
   * `persistAuditRun` for why the difference is load-bearing.
   */
  readonly telemetryResults: readonly AnalyzerRunFindings[];
  /** Non-null iff the telemetry tier did not run. Never discarded by a caller. */
  readonly telemetrySkippedReason: string | null;
  /** Every finding from every tier that ran, ranked for display. */
  readonly ranked: readonly Finding[];
}

/**
 * Filesystem-only analyzers. No database, no network.
 *
 * @throws if the tree holds no source files. Every static analyzer returns []
 * for empty input, so a mis-resolved root would render as "0 findings" — a
 * clean bill of health for a run that examined nothing. That is the same
 * did-not-run-reads-as-clean failure this task exists to remove, and it is
 * exactly what prod did (see repo-root.ts), so it fails loudly instead.
 */
function runStaticAnalyzers(root: string): AnalyzerRunFindings[] {
  const files = collectSourceFiles(root, "src");
  if (files.length === 0) {
    throw new Error(`Self-audit collected 0 source files under ${root}/src — refusing to report an empty tree as a clean audit`);
  }
  const testFiles = collectSourceFiles(root, "tests");
  const dependencies = collectDependencies(root);

  return [
    { analyzer: "findDeadExports", findings: findDeadExports(files) },
    { analyzer: "findOrphanModules", findings: findOrphanModules(files) },
    { analyzer: "findOrphanSubsystems", findings: findOrphanSubsystems(files) },
    { analyzer: "findUnusedDependencies", findings: findUnusedDependencies(files, dependencies) },
    { analyzer: "findOversizedPrompts", findings: findOversizedPrompts(files) },
    { analyzer: "findUntestedModules", findings: findUntestedModules(files, testFiles) },
    { analyzer: "findFilesNearLocBudget", findings: findFilesNearLocBudget(files) },
  ];
}

/**
 * Database-backed analyzers. Imported dynamically so a missing DATABASE_URL or a
 * dead Postgres cannot stop the static half — the failure is reported, not
 * swallowed, and the caller is structurally unable to lose it.
 */
async function runTelemetryAnalyzers(): Promise<{
  readonly results: AnalyzerRunFindings[];
  readonly skippedReason: string | null;
}> {
  try {
    const [collect, analyzers] = await Promise.all([
      import("./collect-telemetry.js"),
      import("./analyzers/telemetry.js"),
    ]);

    const [costRows, lessonRows] = await Promise.all([
      collect.collectCostRows(),
      collect.collectLessonRows(),
    ]);

    return {
      results: [
        { analyzer: "findCostHotspots", findings: analyzers.findCostHotspots(costRows) },
        { analyzer: "findRecurringFailures", findings: analyzers.findRecurringFailures(lessonRows) },
        { analyzer: "findUnappliedLessons", findings: analyzers.findUnappliedLessons(lessonRows) },
      ],
      skippedReason: null,
    };
  } catch (error) {
    // No partial coverage: if any part of the tier failed we report the WHOLE
    // tier as not-run. Claiming coverage we do not have is the failure this
    // module exists to prevent.
    return { results: [], skippedReason: error instanceof Error ? error.message : String(error) };
  }
}

/** Run every analyzer tier once. The only orchestration path — CLI and cron both call this. */
export async function runSelfAudit(root: string): Promise<AuditRunResult> {
  const staticResults = runStaticAnalyzers(root);
  const telemetry = await runTelemetryAnalyzers();

  const all = [...staticResults, ...telemetry.results].flatMap((r) => [...r.findings]);

  return {
    staticResults,
    telemetryResults: telemetry.results,
    telemetrySkippedReason: telemetry.skippedReason,
    ranked: rankFindings(all),
  };
}

export type PersistenceOutcome =
  /** `EVOLUTION_PERSIST_FINDINGS` is off — nothing was written and nothing is claimed. */
  | { readonly state: "disabled" }
  /** The write path ran. `result.persisted` is false on a store outage. */
  | { readonly state: "attempted"; readonly result: PersistFindingsResult };

/**
 * Persist one run's findings, gated on `EVOLUTION_PERSIST_FINDINGS` (default
 * OFF, read at call time so a test can flip it per-run).
 *
 * ONLY the analyzers that actually ran are passed through. When the telemetry
 * tier is skipped its analyzers are absent from `analyzerResults` entirely, so
 * `persistFindingsForRun` leaves their prior findings untouched. Passing them
 * with `findings: []` instead would mark every open telemetry finding
 * `resolved` — writing "the sensor was blind" into the database as "everything
 * got fixed", permanently. Pinned by tests/unit/evolution/run-audit.test.ts.
 */
export async function persistAuditRun(
  run: AuditRunResult,
  opts: { readonly commitSha?: string | null } = {},
): Promise<PersistenceOutcome> {
  if (process.env["EVOLUTION_PERSIST_FINDINGS"] !== "true") return { state: "disabled" };

  const result = await persistFindingsForRun({
    tenantId: AUDIT_TENANT,
    commitSha: opts.commitSha ?? process.env["GIT_COMMIT_SHA"] ?? null,
    loop: "audit",
    analyzerResults: [...run.staticResults, ...run.telemetryResults],
  });

  return { state: "attempted", result };
}
