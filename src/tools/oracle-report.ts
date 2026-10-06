/**
 * FounderOS - post-deploy oracle report (pure part)
 * =================================================
 * After a deploy, which merged pipeline tasks can now be checked against prod, what did each oracle say, and what
 * does the founder read? Pure: records in, rows and text out. The script does the I/O (scripts/oracle-report.ts).
 *
 * The rule that matters: UNKNOWN never becomes PASS. A unit-only oracle, a probe that is not wired and a fetch that
 * failed are all UNKNOWN, and the text says UNKNOWN means "nothing checked this change on prod", never "fine".
 * A task is reported once. An http check that could not run (UNKNOWN because the observation failed) is retried at the
 * next deploy, up to MAX_ATTEMPTS, because a service that is still starting is not a verdict.
 */

import type { ContractRecord } from "./contract-store.js";
import type { Observation, Oracle, PostDeployStatus } from "./oracle.js";
import { evaluatePostDeploy } from "./oracle.js";
import { observeHttp, type FetchLike } from "./oracle-http.js";

export const MAX_ATTEMPTS = 3;

export interface ReportTask {
  repo: string;
  issue: number;
  pr: number | undefined;
  merged_sha: string;
  oracle: Oracle;
}

export interface ReportRow {
  task: ReportTask;
  status: PostDeployStatus;
  reason: string;
  /** True when the reason is "could not observe": worth a retry at the next deploy. */
  transient: boolean;
}

/** What the script keeps per reported task, in <contracts dir>/oracle-reports/<key>.json. */
export interface ReportMark {
  status: PostDeployStatus;
  attempts: number;
  final: boolean;
  deployed: string;
  at: string;
}

export const reportKey = (repo: string, issue: number, mergedSha: string): string =>
  `${repo.replace("/", "__")}__${issue}__${mergedSha.slice(0, 12)}`;

/** Merged tasks whose merge commit is in the deployed tree and that have no final mark yet. */
export function selectTasks(
  records: readonly ContractRecord[],
  contains: (sha: string) => boolean,
  marks: ReadonlyMap<string, ReportMark>,
): ReportTask[] {
  const out: ReportTask[] = [];
  for (const r of records) {
    if (!r.merged_sha) continue;
    if (marks.get(reportKey(r.repo, r.issue, r.merged_sha))?.final === true) continue;
    if (!contains(r.merged_sha)) continue;
    out.push({ repo: r.repo, issue: r.issue, pr: r.pr, merged_sha: r.merged_sha, oracle: r.contract.oracle });
  }
  return out;
}

/** A telegram probe is not wired, so it is UNKNOWN with that reason; an http oracle is fetched (allowlisted hosts only). */
export async function observeOracle(oracle: Oracle, fetchImpl: FetchLike, timeoutMs: number, allowedHosts: readonly string[]): Promise<Observation> {
  if (oracle.kind === "http") return observeHttp(oracle, fetchImpl, timeoutMs, allowedHosts);
  if (oracle.kind === "telegram") return { error: "telegram probe is not wired" };
  return {};
}

export async function judgeTask(task: ReportTask, fetchImpl: FetchLike, timeoutMs: number, allowedHosts: readonly string[]): Promise<ReportRow> {
  let observation: Observation;
  try {
    observation = await observeOracle(task.oracle, fetchImpl, timeoutMs, allowedHosts);
  } catch (err) {
    // allow-failopen: an observation that throws is reported as UNKNOWN with the reason, never as PASS
    observation = { error: err instanceof Error ? err.message : String(err) };
  }
  const verdict = evaluatePostDeploy(task.oracle, observation);
  return { task, status: verdict.status, reason: verdict.reason, transient: verdict.status === "UNKNOWN" && observation.error !== undefined && task.oracle.kind === "http" };
}

/** The mark to store for a row: final unless the check could not run and attempts remain. */
export function nextMark(row: ReportRow, previous: ReportMark | undefined, deployed: string, at: string): ReportMark {
  const attempts = (previous?.attempts ?? 0) + 1;
  return { status: row.status, attempts, final: !row.transient || attempts >= MAX_ATTEMPTS, deployed, at };
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

export function renderReport(deployed: string, rows: readonly ReportRow[]): string {
  const n = (s: PostDeployStatus): number => rows.filter((r) => r.status === s).length;
  const lines = [`Post-deploy check of ${rows.length} merged task(s) at ${deployed.slice(0, 7)}: ${n("PASS")} PASS, ${n("FAIL")} FAIL, ${n("UNKNOWN")} UNKNOWN.`];
  for (const r of rows) {
    const where = `${r.task.repo}#${r.task.issue}${r.task.pr ? ` (PR #${r.task.pr})` : ""}`;
    const retry = r.transient ? " Will retry at the next deploy." : "";
    lines.push(`${r.status} ${where}, oracle ${oneLine(r.task.oracle.id, 60)}: ${oneLine(r.reason, 300)}.${retry}`);
  }
  if (n("UNKNOWN") > 0) lines.push("UNKNOWN means nothing checked that change on prod. It does not mean it works.");
  if (n("FAIL") > 0) lines.push("A FAIL means prod does not show the expected behaviour: look at it before the next change on top of it.");
  return lines.join("\n");
}
