/**
 * FounderOS — Worker Contract Validation
 * ========================================
 * Pure helpers for parsing and validating WorkerContracts.
 * Never throws — returns a discriminated union so callers decide how to fail.
 */

import { WorkerContractSchema, type WorkerContract } from "./types.js";
import type { ZodError } from "zod";

export interface ContractParseSuccess {
  ok: true;
  contract: WorkerContract;
}

export interface ContractParseFailure {
  ok: false;
  errors: string[];
}

export type ContractParseResult = ContractParseSuccess | ContractParseFailure;

/** Parse and validate a raw object as a WorkerContract. Never throws. */
export function parseWorkerContract(raw: unknown): ContractParseResult {
  const result = WorkerContractSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, contract: result.data };
  }
  return {
    ok: false,
    errors: formatZodErrors(result.error),
  };
}

/** Validate an already-typed contract (e.g. from a fixture). Never throws. */
export function validateWorkerContract(contract: WorkerContract): ContractParseResult {
  return parseWorkerContract(contract);
}

/** Format Zod validation errors into human-readable strings. Pure. */
function formatZodErrors(error: ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}
