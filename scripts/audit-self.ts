/**
 * M0a — self-audit runner (`pnpm audit:self`).
 * =============================================
 * The CLI VIEW of the self-audit. Until this existed, every analyzer was proven
 * only against fixtures its own author wrote — 62 green tests over code that had
 * never once seen the real tree. This is the entry point that makes the sensor
 * falsifiable.
 *
 * Deliberately NOT part of `pnpm gate`. It is a sensor, not a gate: the moment a
 * finding can fail a build, the incentive becomes arguing the number down.
 *
 * The orchestration itself lives in src/evolution/run-audit.ts and is shared with
 * the cron acting loop (src/evolution/audit-sweep.ts). Keeping one runner is the
 * fix for a real defect: when this file owned the logic, the cron path re-derived
 * it and lost `skippedReason`, so a telemetry tier that never ran reported to the
 * founder as a telemetry tier that came back clean.
 *
 * Two tiers:
 *   static    — filesystem only, always runs.
 *   telemetry — needs Postgres. If the database is unreachable the run continues
 *               and says so in full. A skipped section and a clean section must
 *               never look the same from outside.
 */

import { runSelfAudit, persistAuditRun, TELEMETRY_ANALYZERS } from "../src/evolution/run-audit.js";
import { renderAuditMessage } from "../src/evolution/audit-message.js";
import { repoRoot } from "../src/evolution/repo-root.js";
import type { Finding } from "../src/evolution/types.js";

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
  const run = await runSelfAudit(repoRoot());
  const persistence = await persistAuditRun(run);

  const staticCount = run.staticResults.reduce((n, r) => n + r.findings.length, 0);
  const telemetryCount = run.telemetryResults.reduce((n, r) => n + r.findings.length, 0);

  console.log(`FounderOS self-audit — ${run.ranked.length} findings\n`);
  console.log(`STATIC     ${staticCount} findings (filesystem)`);

  if (run.telemetrySkippedReason === null) {
    console.log(`TELEMETRY  ${telemetryCount} findings (database)\n`);
  } else {
    console.log(
      `TELEMETRY  SKIPPED — ${TELEMETRY_ANALYZERS.join(", ")}\n` +
        `           did NOT run. This is not a clean result, it is no result.\n` +
        `           Reason: ${run.telemetrySkippedReason}\n`,
    );
  }

  if (persistence.state === "disabled") {
    console.log("PERSIST    OFF (EVOLUTION_PERSIST_FINDINGS != true) — nothing written, no recurrence delta\n");
  } else if (persistence.result.persisted) {
    const r = persistence.result;
    console.log(
      `PERSIST    run ${r.runId} — ${r.newCount} new, ${r.recurringCount} recurring, ` +
        `${r.regressedCount} regressed, ${r.resolvedCount} resolved\n`,
    );
  } else {
    console.log(`PERSIST    FAILED — ${persistence.result.error}\n`);
  }

  if (run.ranked.length > 0) {
    console.log("All findings, ranked:");
    console.log(renderFullList(run.ranked));
  }

  console.log("\n─── Telegram message as the founder would receive it ───\n");
  console.log(renderAuditMessage(run, persistence));

  // Always exit 0: this reports, it does not gate.
  await import("../src/db/client.js")
    .then((m) => m.closeDatabaseConnections?.())
    .catch(() => undefined); // allow-failopen: teardown only; the report is already printed
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
