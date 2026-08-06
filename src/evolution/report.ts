/**
 * M0a — Evolution Engine v0: report renderer.
 * ============================================
 * Pure text rendering of ranked findings for Telegram delivery.
 */

import type { Finding, Severity } from "./types.js";

/** Telegram hard-caps a message at 4096 characters; leave room for the gateway's own wrapper. */
export const TELEGRAM_SAFE_CHARS = 3500;

/** Findings shown before the "+ N more" line. */
export const DEFAULT_MAX_ITEMS = 12;

/**
 * Evidence longer than this is cut with a visible marker instead of dropping the
 * finding. Withholding a high-severity row entirely — severity, subject and all —
 * is indistinguishable from having found nothing, and that ambiguity is the exact
 * failure this renderer exists to avoid.
 */
export const MAX_EVIDENCE_CHARS = 400;

const TRUNCATION_MARKER = "... (evidence truncated)";

export interface RenderOptions {
  readonly maxItems?: number;
}

export const SEVERITY_MARKERS: Readonly<Record<Severity, string>> = {
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

/** `+ 3 more not shown (14 total).` — never abbreviated away, never silent. */
const withheldLine = (withheld: number, total: number): string =>
  `+ ${withheld} more not shown (${total} total).`;

/**
 * One finding as [blank separator, title, evidence]. The location is printed only
 * when it says something the subject does not — for a dead export the subject is a
 * symbol and the location is the file to open; for a whole-file finding they match.
 */
function renderBlock(finding: Finding): string[] {
  const where =
    finding.location && finding.location !== finding.subject ? ` (${finding.location})` : "";
  const evidence =
    finding.evidence.length > MAX_EVIDENCE_CHARS
      ? `${finding.evidence.slice(0, MAX_EVIDENCE_CHARS)}${TRUNCATION_MARKER}`
      : finding.evidence;

  return ["", `${SEVERITY_MARKERS[finding.severity]} ${finding.subject}${where}`, evidence];
}

/**
 * Render findings into a Telegram-ready plain text report.
 * Assumes findings are already ranked.
 */
export function renderReport(findings: readonly Finding[], opts?: RenderOptions): string {
  if (findings.length === 0) {
    return "Self-audit: no findings.";
  }

  const maxItems = opts?.maxItems ?? DEFAULT_MAX_ITEMS;
  const totalCount = findings.length;

  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  for (const finding of findings) {
    if (finding.severity === "high") highCount++;
    else if (finding.severity === "medium") mediumCount++;
    else lowCount++;
  }

  const noun = totalCount === 1 ? "finding" : "findings";
  const header = `Self-audit: ${totalCount} ${noun} (${highCount} high, ${mediumCount} medium, ${lowCount} low)`;

  const lines: string[] = [header];
  let shownCount = 0;

  for (let i = 0; i < findings.length && i < maxItems; i++) {
    const block = renderBlock(findings[i]!);

    // Cost the footer this item would leave behind, so the "+ N more" line can
    // never be the thing that pushes the message over Telegram's cap.
    const withheldAfter = totalCount - (shownCount + 1);
    const footer = withheldAfter > 0 ? `\n\n${withheldLine(withheldAfter, totalCount)}` : "";

    if ([...lines, ...block].join("\n").length + footer.length > TELEGRAM_SAFE_CHARS) {
      break;
    }

    lines.push(...block);
    shownCount++;
  }

  const withheld = totalCount - shownCount;
  if (withheld > 0) {
    lines.push("", withheldLine(withheld, totalCount));
  }

  return lines.join("\n");
}
