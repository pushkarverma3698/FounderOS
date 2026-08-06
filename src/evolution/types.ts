/**
 * M0a — Evolution Engine v0: shared analyzer contracts.
 * ======================================================
 * A Finding is the atom of the self-audit. Analyzers are PURE functions over
 * already-read source text — no I/O — so the whole sensor runs in CI at $0 and
 * its numbers are reproducible.
 *
 * `evidence` is not a debug string. Per the founder-facing legibility rule, it
 * must explain the finding to someone who has never read the code: state what
 * was measured and what the measurement was, never an internal label.
 */

/** One source file, already read. Analyzers never touch the filesystem. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export const FINDING_KINDS = [
  "dead-export",
  "orphan-module",
  "unused-dependency",
  "oversized-prompt",
  "untested-module",
  "loc-pressure",
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
}
