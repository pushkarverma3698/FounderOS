export const FINDING_KINDS = [
  "dead-export",
  "orphan-module",
  "unused-dependency",
  "oversized-prompt",
  "untested-module",
  "loc-pressure",
  "cost-hotspot",
  "recurring-failure",
  "unapplied-lesson",
  // Jobhunt data checks (analyzers/jobhunt.ts). The first two have an
  // implementation fix and become issues; the last two are decisions for the
  // founder and are never dispatched (see GUIDANCE in issue-body.ts).
  "adapter-silent",
  "apply-link-unrecognised",
  "lane-silent",
  "candidate-not-acting",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** high = costs money or hides risk now · medium = real debt · low = tidiness. */
export type Severity = "high" | "medium" | "low";

export interface Finding {
  readonly kind: FindingKind;
  /** The thing itself: a symbol name, a module path, a package name. */
  readonly subject: string;
  /** Why we believe it — legible without reading the code. */
  readonly evidence: string;
  readonly severity: Severity;
  readonly location?: string;
  /**
   * What the finding was computed from, one line each: the counts the analyzer
   * measured, then sample rows it read, quoted as stored (only characters that could
   * break Markdown or forge the fingerprint marker are replaced). An auto-filed
   * issue prints them in its Evidence section, because the executor has no access to
   * the database that produced them. Nothing here may be invented: a row that was
   * not in the input is worse than none.
   */
  readonly evidenceRows?: readonly string[];
}
