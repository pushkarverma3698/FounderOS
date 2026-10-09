/**
 * FounderOS — what pr-brain said about a PR, as facts for the status answer
 * =========================================================================
 * pr-brain ends its review comment with a typed verdict (src/tools/review-verdict.ts): a fenced
 * json block {version, head_sha, decision, findings}. The status answer used to ignore it, so the
 * bot could not say WHY a PR was blocked and improvised ("review is not yet complete") while the
 * verdict, with both blockers, sat on the PR (Oplify #116, 2026-10-09).
 *
 * Pure. No I/O, no clock beyond the `now` passed in.
 */

import { parseReviewVerdict, type ReviewFinding } from "./review-verdict.js";

export interface VerdictFacts {
  readonly decision: "APPROVE" | "REQUEST_CHANGES" | "UNKNOWN";
  readonly findings: readonly ReviewFinding[];
}

const FENCE = /```json[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
const MAX_SHOWN = 10;
const CLAIM_CHARS = 400;
const EVIDENCE_CHARS = 240;

/** True when two shas name the same commit (pr-brain writes short and long forms). */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** Head sha named by the LAST fenced json block of a comment, or undefined. */
function verdictHead(body: string): string | undefined {
  let last: string | undefined;
  for (const m of body.matchAll(FENCE)) last = m[1];
  if (last === undefined) return undefined;
  try {
    const v = JSON.parse(last) as { head_sha?: unknown };
    return typeof v.head_sha === "string" ? v.head_sha : undefined;
  } catch {
    // allow-failopen: a comment whose last json block is not a verdict is simply not one.
    return undefined;
  }
}

/**
 * The newest verdict that names `headSha`, or null. A verdict for an older head is NOT this
 * head's verdict (CLAUDE.md #35): it is skipped, never shown as current.
 */
export function latestVerdictForHead(bodies: readonly string[], headSha: string): VerdictFacts | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i]!;
    const named = verdictHead(body);
    if (named === undefined || !sameCommit(named, headSha)) continue;
    const v = parseReviewVerdict(body, named);
    return { decision: v.decision, findings: v.findings };
  }
  return null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function blockersOf(v: VerdictFacts | null | undefined): ReviewFinding[] {
  return v ? v.findings.filter((f) => f.severity === "blocker") : [];
}

/** One line per blocker, verbatim claim plus the evidence pr-brain quoted. Capped, never silently. */
export function blockerLines(v: VerdictFacts | null | undefined): string[] {
  const blockers = blockersOf(v);
  if (blockers.length === 0) return [];
  const lines = [`${blockers.length} blocker${blockers.length === 1 ? "" : "s"} from pr-brain:`];
  blockers.slice(0, MAX_SHOWN).forEach((b, i) => {
    const where = b.file ? ` (${b.file}${b.line ? `:${b.line}` : ""})` : "";
    lines.push(`  ${i + 1}. ${clip(b.claim, CLAIM_CHARS)}${where}`);
    lines.push(`     evidence: ${clip(b.evidence, EVIDENCE_CHARS)}`);
  });
  if (blockers.length > MAX_SHOWN) lines.push(`  +${blockers.length - MAX_SHOWN} more blockers on the PR.`);
  const other = (v?.findings.length ?? 0) - blockers.length;
  if (other > 0) lines.push(`  (plus ${other} non-blocking note${other === 1 ? "" : "s"})`);
  return lines;
}

/** pr-brain's cron is `*\/20`: the next :00 / :20 / :40 after `now`. */
export function nextPrBrainRun(now: Date): Date {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.floor(now.getUTCMinutes() / 20) * 20 + 20);
  return next;
}
