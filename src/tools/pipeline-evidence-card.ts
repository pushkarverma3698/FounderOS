/**
 * FounderOS - coding pipeline: what the evidence card is built from
 * =================================================================
 * Pure helpers for scripts/pipeline-evidence-card.ts. Three judgements live here so they can be unit-tested and so
 * the dispatcher's bash never makes them:
 *  - what pr-brain's verdict text means as a review decision (only two states count; everything else is UNKNOWN),
 *  - what an evidence verdict read from another process is worth (anything but a clean PASS for THIS head is not a pass),
 *  - what nobody has checked yet (a unit-only oracle: nothing looks at prod after the deploy).
 */
import type { TaskContract } from "./task-contract.js";

export type ReviewDecision = "APPROVE" | "REQUEST_CHANGES" | "UNKNOWN";
export interface ReadVerdict {
  status: "PASS" | "FAIL" | "UNKNOWN";
  reasons: string[];
  head_sha: string;
}

/**
 * pr-brain's pr_verdict() text starts with the state. Only a leading CLEARED or APPROVED is an approval, only a
 * leading CHANGES REQUESTED is a rejection. "left as draft", "unknown" and the empty string are neither.
 */
export function reviewDecisionOf(verdict: string): ReviewDecision {
  const v = verdict.trimStart();
  if (v.startsWith("CLEARED") || v.startsWith("APPROVED")) return "APPROVE";
  if (v.startsWith("CHANGES REQUESTED")) return "REQUEST_CHANGES";
  return "UNKNOWN";
}

/** Things nobody has checked. A non-empty list swaps [Merge] for [I checked it — merge]. */
export function notVerifiedFor(contract: TaskContract): string[] {
  if (contract.oracle.kind === "unit-only") {
    return [`oracle ${contract.oracle.id} is unit-only: after the deploy nothing checks this change on prod`];
  }
  return [];
}

/** Evidence JSON from scripts/pr-evidence.ts, read defensively: only an exact PASS or FAIL for `head` keeps its status. */
export function readVerdict(raw: unknown, head: string): ReadVerdict {
  const unknown = (why: string): ReadVerdict => ({ status: "UNKNOWN", reasons: [why], head_sha: head });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unknown("the evidence run returned nothing readable");
  const o = raw as Record<string, unknown>;
  const reasons = Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === "string") ? (o.reasons as string[]) : null;
  if (o.status !== "PASS" && o.status !== "FAIL") {
    return { status: "UNKNOWN", reasons: reasons && reasons.length > 0 ? reasons : [`the evidence run returned status ${JSON.stringify(o.status)}`], head_sha: head };
  }
  if (reasons === null) return unknown("the evidence run returned no reasons list");
  if (o.status === "PASS") {
    if (o.head_sha !== head) return unknown(`evidence was computed for head ${String(o.head_sha)}, not the head under review ${head}`);
    if (reasons.length > 0) return unknown("evidence says PASS but carries reasons: " + reasons.join("; "));
  }
  return { status: o.status, reasons, head_sha: typeof o.head_sha === "string" && o.head_sha ? o.head_sha : head };
}
