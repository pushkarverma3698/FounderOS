/**
 * Outcome oracle: pure core.
 *
 * An oracle says what observable behaviour a merged task must produce on prod. This module only
 * compares an observation against the oracle's `expected_after` predicate and reads the
 * `FOUNDEROS_ORACLE <id> <json>` markers a test may print. No network, no fs, no clock.
 * UNKNOWN never becomes PASS: anything we could not observe or compare is UNKNOWN, with the reason.
 *
 * Shape copied from the coding-pipeline thin-slice shared spec (TaskContract.oracle); kept local so
 * this file does not depend on task-contract.ts.
 */

import { z } from "zod";

export type Predicate = Record<string, string | number | boolean | null>;

export interface Oracle {
  id: string;
  kind: "http" | "telegram" | "unit-only"; // unit-only => post-deploy result is UNKNOWN
  target?: string; // URL for http, probe text for telegram
  before: Predicate;
  expected_after: Predicate;
}

export const PredicateSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const OracleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["http", "telegram", "unit-only"]),
  target: z.string().optional(),
  before: PredicateSchema,
  expected_after: PredicateSchema,
});

export type PostDeployStatus = "PASS" | "FAIL" | "UNKNOWN";
export interface PostDeployVerdict {
  status: PostDeployStatus;
  reason: string;
}
export interface Observation {
  actual?: unknown;
  error?: string;
}

const MARKER = "FOUNDEROS_ORACLE";
const MARKER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Own-property walk of a dotted path. Never reads the prototype chain. */
function lookup(actual: unknown, path: string): { found: true; value: unknown } | { found: false } {
  let cur: unknown = actual;
  for (const segment of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, segment)) return { found: false };
    cur = (cur as Record<string, unknown>)[segment];
  }
  return { found: true, value: cur };
}

export function satisfies(actual: unknown, predicate: Predicate): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(predicate)) {
    const found = lookup(actual, key);
    if (!found.found) mismatches.push(`${key}: missing (expected ${show(expected)})`);
    else if (found.value !== expected) mismatches.push(`${key}: expected ${show(expected)}, got ${show(found.value)}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Parse `FOUNDEROS_ORACLE <id> <json>` lines. Malformed marker lines are skipped and counted. */
export function parseOracleMarkers(stdout: string): { markers: Record<string, unknown>; malformed: number } {
  const markers: Record<string, unknown> = {};
  let malformed = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line !== MARKER && !line.startsWith(`${MARKER} `) && !line.startsWith(`${MARKER}\t`)) continue;
    const rest = line.slice(MARKER.length).trim();
    const split = rest.search(/\s/);
    const id = split === -1 ? rest : rest.slice(0, split);
    const json = split === -1 ? "" : rest.slice(split).trim();
    if (!MARKER_ID.test(id) || json === "") {
      malformed++;
      continue;
    }
    try {
      markers[id] = JSON.parse(json) as unknown;
    } catch {
      // allow-failopen: a marker line that is not valid JSON is counted as malformed and never read as a value
      malformed++;
    }
  }
  return { markers, malformed };
}

export function readOracleMarkers(stdout: string): Record<string, unknown> {
  return parseOracleMarkers(stdout).markers;
}

export function evaluatePostDeploy(oracle: Oracle, observation: Observation): PostDeployVerdict {
  if (oracle.kind === "unit-only") return { status: "UNKNOWN", reason: "unit-level only" };
  if (observation.error !== undefined) return { status: "UNKNOWN", reason: `observation failed: ${observation.error}` };
  if (observation.actual === undefined) return { status: "UNKNOWN", reason: "no observation" };
  const count = Object.keys(oracle.expected_after).length;
  if (count === 0) return { status: "UNKNOWN", reason: "oracle has no expected_after predicate" };
  const result = satisfies(observation.actual, oracle.expected_after);
  if (result.ok) return { status: "PASS", reason: `${count} predicate(s) satisfied` };
  return { status: "FAIL", reason: result.mismatches.join("; ") };
}
