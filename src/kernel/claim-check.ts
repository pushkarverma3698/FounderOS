/**
 * FounderOS v3 kernel — claim checks on the outbound reply (AG-034).
 * ==================================================================
 * One entry point for the synthesizer: strip promises nothing backs (promise-guard),
 * replace progress claims no status read backs (progress-guard), and log numbers no
 * tool returned (number-check, log only). One `claim.check` line per turn carries the
 * counts per kind, so the journal answers how often the model makes unbacked claims.
 */

import type { StepResult } from "./contracts.js";
import { stripFalsePromises } from "./promise-guard.js";
import { countProgressClaims, stripUnbackedProgress } from "./progress-guard.js";
import { findUnsupportedNumbers } from "./number-check.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "kernel:claim-check" });

export interface ClaimCheckTurn {
  readonly id?: string;
  readonly raw_input?: string;
}

/** The founder-facing reply after the promise and progress guards; numbers are only logged. */
export function applyClaimChecks(text: string, results: readonly StepResult[], turn?: ClaimCheckTurn): string {
  const turnId = turn?.id ?? "unknown";
  const noPromises = stripFalsePromises(text, results);
  const reply = stripUnbackedProgress(noPromises, results);
  const unbackedNumbers = findUnsupportedNumbers(reply, results, turn?.raw_input ?? "");
  for (const number of unbackedNumbers) log.info({ turnId, event: "claim_check.number", number }, "claim_check.number");
  const counts = {
    promise: noPromises === text ? 0 : 1,
    progress: reply === noPromises ? 0 : countProgressClaims(noPromises),
    number: unbackedNumbers.length,
  };
  log.info({ seam: "claim.check", turnId, ...counts }, "trace claim.check");
  return reply;
}
