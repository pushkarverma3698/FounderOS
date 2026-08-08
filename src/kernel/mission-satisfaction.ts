/**
 * FounderOS v3 kernel — Mission-Level Satisfaction Gate (Phase 4 — T3)
 * =====================================================================
 * Asserts whether a completed set of step results genuinely satisfies the mission's goal.
 * Pure function: goal + steps + results → satisfaction verdict.
 * Prevents partial completions (e.g., 3 of 39 rows delivered) from claiming "Mission complete".
 */

import type { StepResult, TaskEnvelope } from "./contracts.js";

export interface MissionSatisfactionVerdict {
  readonly ok: boolean;
  readonly unmet?: readonly string[];
}

export function missionSatisfied(
  goal: string,
  _steps: readonly TaskEnvelope[],
  results: readonly StepResult[],
): MissionSatisfactionVerdict {
  const unmet: string[] = [];

  // 1. Assert no step failed
  for (const r of results) {
    if (r.status === "failed") {
      unmet.push(`Step '${r.step_id}' failed: ${r.failure.message}`);
    }
  }

  // 2. Check record count completeness when user asks for "all" records/jobs
  const goalLower = goal.toLowerCase();
  const asksForAll =
    goalLower.includes("all jobs") ||
    goalLower.includes("list all") ||
    goalLower.includes("every job") ||
    goalLower.includes("export all");

  if (asksForAll) {
    for (const r of results) {
      if (r.status === "ok" && r.observed?.kind === "record") {
        const mCount = /count:(\d+)/.exec(r.observed.evidence);
        const mTotal = /total:(\d+)/.exec(r.observed.evidence);
        if (mCount && mTotal) {
          const count = parseInt(mCount[1]!, 10);
          const total = parseInt(mTotal[1]!, 10);
          if (total > count) {
            unmet.push(`Requested all records, but delivered ${count} of ${total} total records.`);
          }
        }
      }
    }
  }

  // 3. Check delivery assertion when user asks to "send" or "deliver" an attachment/file
  const asksForDelivery =
    goalLower.includes("send me") ||
    goalLower.includes("deliver") ||
    goalLower.includes("attach") ||
    goalLower.includes("send to telegram");

  if (asksForDelivery) {
    const hasDelivery = results.some(
      (r) => r.status === "ok" && (r.observed?.kind === "message" || JSON.stringify(r.output).includes("delivered")),
    );
    if (!hasDelivery) {
      unmet.push("Delivery requested, but no file delivery attachment step succeeded.");
    }
  }

  return unmet.length > 0 ? { ok: false, unmet } : { ok: true };
}
