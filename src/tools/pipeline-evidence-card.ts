/**
 * FounderOS - coding pipeline: what the merge card is built from
 * ==============================================================
 * Pure helpers for scripts/pipeline-evidence-card.ts, so pr-brain's bash never makes these judgements:
 *  - what pr-brain's verdict text means as a review decision (only two states count; everything else is UNKNOWN),
 *  - what the PR's required CI checks say for the head under review (anything but every required check passing or
 *    skipped is not a pass). The reading matches deploy/lib/ci-state.sh.
 */

export type ReviewDecision = "APPROVE" | "REQUEST_CHANGES" | "UNKNOWN";
export interface CiVerdict {
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

/**
 * The output of `gh pr checks N --required --json bucket,name`, read for `head`. gh exits 1 with a sentence for a
 * branch with no required checks, so neither the exit code nor an empty list is trusted to mean green.
 */
export function requiredCiVerdict(stdout: string, head: string): CiVerdict {
  const unknown = (why: string): CiVerdict => ({ status: "UNKNOWN", reasons: [why], head_sha: head });
  let checks: unknown;
  try {
    checks = JSON.parse(stdout) as unknown;
  } catch {
    // allow-failopen: not JSON is an UNKNOWN row, which never carries a merge button
    return unknown("the base branch has no required checks, or GitHub could not be read: " + (stdout.trim().slice(0, 160) || "no output"));
  }
  if (!Array.isArray(checks) || checks.length === 0) return unknown("the base branch has no required checks");
  const named = checks.map((c) => (typeof c === "object" && c !== null ? (c as { bucket?: unknown; name?: unknown }) : {}));
  const nameOf = (c: { name?: unknown }): string => (typeof c.name === "string" && c.name ? c.name : "(unnamed check)");
  const failed = [...new Set(named.filter((c) => c.bucket === "fail").map(nameOf))];
  if (failed.length > 0) return { status: "FAIL", reasons: failed.map((n) => `required check failed: ${n}`), head_sha: head };
  const open = [...new Set(named.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping").map(nameOf))];
  if (open.length > 0) return unknown("required checks have no result yet: " + open.join(", "));
  return { status: "PASS", reasons: [], head_sha: head };
}
