/**
 * M0a — self-audit runner (`pnpm audit:self`).
 * =============================================
 * Runs the Evolution Engine's analyzers against THIS repository and prints the
 * result. Until this existed, every analyzer was proven only against fixtures its
 * own author wrote — 62 green tests over code that had never once seen the real
 * tree. This is the entry point that makes the sensor falsifiable.
 *
 * Deliberately NOT part of `pnpm gate`. It is a sensor, not a gate: the moment a
 * finding can fail a build, the incentive becomes arguing the number down.
 *
 * Two tiers:
 *   static    — filesystem only, always runs.
 *   telemetry — needs Postgres. If the database is unreachable the run continues
 *               and says so in full. A skipped section and a clean section must
 *               never look the same from outside.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { collectDependencies, collectSourceFiles } from "../src/evolution/collect.js";
import {
  findDeadExports,
  findOrphanModules,
  findOrphanSubsystems,
  findUnusedDependencies,
} from "../src/evolution/analyzers/dead-code.js";
import {
  findFilesNearLocBudget,
  findOversizedPrompts,
  findUntestedModules,
} from "../src/evolution/analyzers/code-health.js";
import { rankFindings } from "../src/evolution/rank.js";
import { renderReport } from "../src/evolution/report.js";
import type { Finding } from "../src/evolution/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Filesystem-only analyzers. No database, no network, no excuses. */
function runStaticAnalyzers(): Finding[] {
  const files = collectSourceFiles(ROOT, "src");
  const testFiles = collectSourceFiles(ROOT, "tests");
  const dependencies = collectDependencies(ROOT);

  return [
    ...findDeadExports(files),
    ...findOrphanModules(files),
    ...findOrphanSubsystems(files),
    ...findUnusedDependencies(files, dependencies),
    ...findOversizedPrompts(files),
    ...findUntestedModules(files, testFiles),
    ...findFilesNearLocBudget(files),
  ];
}

/**
 * Database-backed analyzers. Imported dynamically so that a missing DATABASE_URL
 * or a dead Postgres cannot stop the static half from running — the failure is
 * reported, not swallowed.
 */
async function runTelemetryAnalyzers(): Promise<{
  readonly findings: Finding[];
  readonly skippedReason: string | null;
}> {
  try {
    const [collect, analyzers] = await Promise.all([
      import("../src/evolution/collect-telemetry.js"),
      import("../src/evolution/analyzers/telemetry.js"),
    ]);

    const [costRows, lessonRows] = await Promise.all([
      collect.collectCostRows(),
      collect.collectLessonRows(),
    ]);

    return {
      findings: [
        ...analyzers.findCostHotspots(costRows),
        ...analyzers.findRecurringFailures(lessonRows),
        ...analyzers.findUnappliedLessons(lessonRows),
      ],
      skippedReason: null,
    };
  } catch (error) {
    return {
      findings: [],
      skippedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One line per finding — the audit view, where nothing is ever withheld. */
function renderFullList(findings: readonly Finding[]): string {
  return findings
    .map((finding) => {
      const where =
        finding.location && finding.location !== finding.subject ? `  ${finding.location}` : "";
      return `  ${finding.severity.toUpperCase().padEnd(6)} ${finding.kind.padEnd(20)} ${finding.subject}${where}`;
    })
    .join("\n");
}

async function main(): Promise<void> {
  const staticFindings = runStaticAnalyzers();
  const telemetry = await runTelemetryAnalyzers();
  const ranked = rankFindings([...staticFindings, ...telemetry.findings]);

  console.log(`FounderOS self-audit — ${ranked.length} findings\n`);
  console.log(`STATIC     ${staticFindings.length} findings (filesystem)`);

  if (telemetry.skippedReason === null) {
    console.log(`TELEMETRY  ${telemetry.findings.length} findings (database)\n`);
  } else {
    console.log(
      `TELEMETRY  SKIPPED — cost-hotspot, recurring-failure and unapplied-lesson\n` +
        `           did NOT run. This is not a clean result, it is no result.\n` +
        `           Reason: ${telemetry.skippedReason}\n`,
    );
  }

  if (ranked.length > 0) {
    console.log("All findings, ranked:");
    console.log(renderFullList(ranked));
  }

  console.log("\n─── Telegram message as the founder would receive it ───\n");
  console.log(renderReport(ranked));

  // Always exit 0: this reports, it does not gate.
  await import("../src/db/client.js")
    .then((m) => m.closeDatabaseConnections?.())
    .catch(() => undefined); // allow-failopen: teardown only; the report is already printed
}

await main();
