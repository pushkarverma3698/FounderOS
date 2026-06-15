// scripts/log-review/digest.ts
import { createHash } from "node:crypto";
import type { Anomaly, Digest, StateFinding, Turn } from "./types.js";

export const MAX_DIGEST_TURNS = 25; // hard cap on borderline turns Claude reads

/** Hard anomalies are the proven faults; candidates only route turns. */
function isHard(a: Anomaly): boolean {
  return a.type !== "hallucination_candidate";
}

/** Stable 12-char hash of the issue set → deterministic branch naming. */
function hashIssues(hard: Anomaly[], state: StateFinding[]): string {
  const key = [
    ...hard.map((a) => `${a.type}:${a.turnId ?? ""}`),
    ...state.map((s) => `${s.type}`),
  ].sort().join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function buildDigest(
  turns: Turn[],
  anomalies: Anomaly[],
  stateFindings: StateFinding[],
  opts: { windowDays: number },
): Digest {
  const hardAnomalies = anomalies.filter(isHard);
  const candidates = anomalies.filter((a) => !isHard(a));

  const candidateIds = new Set(candidates.map((c) => c.turnId));
  const borderlineAll = turns.filter((t) => candidateIds.has(t.turnId));
  const borderlineTurns = borderlineAll.slice(0, MAX_DIGEST_TURNS);

  const errors = turns.filter((t) => t.hadError).length;
  const warns = turns.filter((t) => t.lines.some((l) => l.level === 40)).length;
  const flaggedIds = new Set([...hardAnomalies, ...candidates].map((a) => a.turnId));
  const healthyTurns = turns.filter((t) => !flaggedIds.has(t.turnId)).length;

  return {
    generatedAt: new Date().toISOString(),
    windowDays: opts.windowDays,
    contentHash: hashIssues(hardAnomalies, stateFindings),
    counts: { turns: turns.length, errors, warns, healthyTurns },
    hardAnomalies,
    stateFindings,
    borderlineTurns,
    truncated: borderlineAll.length > MAX_DIGEST_TURNS,
  };
}
