/**
 * M0a — Evolution Engine v0: persist findings across runs.
 * ============================================================
 * Closes "Cut 2" from docs/plans/2026-08-12-self-improvement-audit.md §3: no
 * findings table existed anywhere, so every audit run started from zero and
 * could not tell a brand-new finding from one seen 40 times, or one that was
 * fixed and has now regressed.
 *
 * `persistFindingsForRun` is the ONLY write path into evolution_findings /
 * evolution_runs (src/db/schema.ts holds the status-machine doc). It takes
 * findings already grouped by the analyzer that produced them — that
 * grouping IS the run's coverage, and coverage is what makes "this finding
 * was absent" mean "fixed" rather than "the analyzer that finds it didn't
 * run" (a skipped analyzer, e.g. telemetry with no reachable Postgres, must
 * never look like a wave of fixes).
 *
 * Fails open, loudly: a findings-store outage must not break the report that
 * already ran successfully. Every DB call in this module happens inside the
 * one try/catch below (`persisted: false` on failure) — never a swallowed,
 * silent catch.
 */

import { childLogger } from "../infra/logger.js";
import { computeFingerprint } from "./fingerprint.js";
import type { Finding } from "./types.js";
import {
  startEvolutionRun,
  finishEvolutionRun,
  getEvolutionFindingsByFingerprint,
  upsertEvolutionFinding,
  resolveMissingEvolutionFindings,
} from "../db/queries.js";

const log = childLogger({ module: "evolution-persist-findings" });

/** One analyzer's output for this run. The set of analyzer names present here IS this run's coverage. */
export interface AnalyzerRunFindings {
  readonly analyzer: string;
  readonly findings: readonly Finding[];
}

export interface PersistFindingsInput {
  readonly tenantId: string;
  readonly commitSha: string | null;
  readonly loop: "audit" | "acting";
  readonly analyzerResults: readonly AnalyzerRunFindings[];
}

/** A finding that reappeared after being marked resolved — surfaced distinctly, never buried in "recurring". */
export interface RegressedFinding {
  readonly fingerprint: string;
  readonly kind: string;
  readonly subject: string;
  readonly location?: string;
  readonly timesSeen: number;
}

export interface PersistFindingsResult {
  /** False only on a store outage (fail-open) — every count below is 0 in that case. */
  readonly persisted: boolean;
  readonly runId: string | null;
  /** Fingerprints never seen before this run. */
  readonly newCount: number;
  /** Fingerprints seen before, still `open` (or already `regressed`) — times_seen bumped, status unchanged. */
  readonly recurringCount: number;
  /** Fingerprints that were `resolved` and reappeared — flipped to `regressed`. */
  readonly regressedCount: number;
  /** Fingerprints marked `resolved` this run (coverage-gated absence). */
  readonly resolvedCount: number;
  readonly regressed: readonly RegressedFinding[];
  readonly error?: string;
}

const EMPTY_RESULT: Omit<PersistFindingsResult, "persisted" | "runId" | "error"> = {
  newCount: 0,
  recurringCount: 0,
  regressedCount: 0,
  resolvedCount: 0,
  regressed: [],
};

/**
 * Persist one run's findings: upsert every finding by fingerprint (bumping
 * times_seen, flipping resolved→regressed on reappearance), then — for every
 * analyzer present in `analyzerResults` (i.e. that ran this cycle) — resolve
 * any of its prior open/regressed findings whose fingerprint it did not
 * reproduce this time. An analyzer absent from `analyzerResults` is left
 * completely untouched: its prior findings keep whatever status they had.
 */
export async function persistFindingsForRun(input: PersistFindingsInput): Promise<PersistFindingsResult> {
  const analyzersRun = input.analyzerResults.map((a) => a.analyzer);

  // De-dup within the run: keep the first finding seen for a given fingerprint.
  // (No analyzer in this repo emits two findings with the same fingerprint —
  // see fingerprint.ts — but a duplicate silently overwriting the earlier
  // upsert instead of erroring would be a worse failure mode than this.)
  const byFingerprint = new Map<string, { finding: Finding; analyzer: string; fingerprint: string }>();
  for (const { analyzer, findings } of input.analyzerResults) {
    for (const finding of findings) {
      const fingerprint = computeFingerprint(finding);
      if (!byFingerprint.has(fingerprint)) {
        byFingerprint.set(fingerprint, { finding, analyzer, fingerprint });
      }
    }
  }
  const unique = [...byFingerprint.values()];

  try {
    const runId = await startEvolutionRun({
      tenant_id: input.tenantId,
      commit_sha: input.commitSha,
      loop: input.loop,
      analyzers_run: analyzersRun,
    });

    const prior = await getEvolutionFindingsByFingerprint(
      input.tenantId,
      unique.map((u) => u.fingerprint),
    );
    const priorByFingerprint = new Map(prior.map((row) => [row.fingerprint, row]));

    let newCount = 0;
    let recurringCount = 0;
    let regressedCount = 0;
    const regressed: RegressedFinding[] = [];

    for (const { finding, analyzer, fingerprint } of unique) {
      const before = priorByFingerprint.get(fingerprint);

      await upsertEvolutionFinding({
        tenant_id: input.tenantId,
        fingerprint,
        kind: finding.kind,
        subject: finding.subject,
        severity: finding.severity,
        location: finding.location ?? null,
        detail: finding.evidence,
        analyzer,
        run_id: runId,
      });

      if (!before) {
        newCount++;
      } else if (before.status === "resolved") {
        regressedCount++;
        regressed.push({
          fingerprint,
          kind: finding.kind,
          subject: finding.subject,
          location: finding.location,
          timesSeen: before.times_seen + 1,
        });
      } else {
        recurringCount++;
      }
    }

    let resolvedCount = 0;
    for (const { analyzer, findings } of input.analyzerResults) {
      const currentFingerprints = findings.map((f) => computeFingerprint(f));
      const resolvedRows = await resolveMissingEvolutionFindings(input.tenantId, analyzer, currentFingerprints);
      resolvedCount += resolvedRows.length;
    }

    await finishEvolutionRun(runId, { findings_count: unique.length, outcome: "completed" });

    return { persisted: true, runId, newCount, recurringCount, regressedCount, resolvedCount, regressed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, tenant_id: input.tenantId, loop: input.loop }, "evolution findings persistence failed (non-fatal)");
    // allow-failopen: a findings-store outage must not break the self-audit report,
    // which already ran and produced a valid Telegram message before this is called.
    return { persisted: false, runId: null, ...EMPTY_RESULT, error: message };
  }
}
