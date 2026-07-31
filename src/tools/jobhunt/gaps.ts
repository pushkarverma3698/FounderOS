/**
 * FounderOS — cv_gaps tool
 * ========================
 * The resume half of the loop: what the reachable market asks for, against what
 * the CV actually says.
 *
 * It SUGGESTS. It never edits. There is no write path from here to the CV or to
 * personal-rag (ADR-015 — read-only), by construction rather than by policy.
 *
 * Two decisions carry the whole value of the output:
 *
 *   1. Only postings that PASSED the gates contribute signals (enforced in
 *      screen.ts). The market at large is noise; the roles Pushkar can legally
 *      hold are the only population his CV needs to match. A gap report built on
 *      unfiltered postings would recommend skills for jobs the sponsor gate
 *      would have rejected anyway.
 *
 *   2. The sample size is printed next to every percentage. "68% of postings"
 *      over 4 postings and over 400 are the same number and mean entirely
 *      different things, and the first invites a CV rewrite on noise.
 */

import { childLogger } from "../../infra/logger.js";
import { listSignals } from "../../db/cv-signal-queries.js";
import { countPassingApplications } from "../../db/job-queries.js";
import { readFullCvText } from "../career.js";
import { extractSkillTerms } from "./skills.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:cv_gaps" });

/**
 * Below this many passing postings, percentages are not reported as findings.
 * Three postings can put any term at 100%.
 */
export const MIN_SAMPLE_FOR_PERCENTAGES = 10;

/** An unknown term must recur before it is worth the founder's attention. */
export const UNKNOWN_REPORT_THRESHOLD = 5;

/** Terms below this share of the market are noise in a gap list. */
const MIN_SHARE_TO_REPORT = 0.15;

export interface SignalRow {
  readonly term: string;
  readonly category: string;
  readonly seen_count: number;
}

export interface GapReport {
  readonly sampleSize: number;
  /** Frequent in the market, absent from the CV. */
  readonly missing: readonly SignalRow[];
  /** Present in both — evidence the CV is aimed correctly. */
  readonly confirmed: readonly SignalRow[];
  /** Recurring terms the dictionary doesn't know, for the founder to promote. */
  readonly rising: readonly SignalRow[];
  /** Recognisable skill terms found in the CV — the report's other denominator. */
  readonly cvTermCount: number;
}

/**
 * A CV yielding fewer recognisable terms than this cannot support a claim about
 * absence. The MISSING list is a statement about the CV as much as about the
 * market, and a thin CV makes the entire market look like a gap.
 */
export const MIN_CV_TERMS_FOR_GAPS = 5;

/**
 * Split market signals against the CV. Pure — the CV text and the signal rows
 * are both passed in, so the whole classification is unit-testable with no DB
 * and no personal-rag.
 *
 * CV matching reuses `extractSkillTerms`, the SAME extractor that produced the
 * market signals. Matching the CV with different logic than the postings is how
 * a report ends up claiming a gap in a skill the CV states plainly.
 */
export function buildGapReport(
  signals: readonly SignalRow[],
  cvText: string,
  sampleSize: number,
): GapReport {
  const cvTerms = new Set(extractSkillTerms(cvText).map((s) => s.term));
  const floor = Math.max(1, Math.ceil(sampleSize * MIN_SHARE_TO_REPORT));

  const known = signals.filter((s) => s.category !== "unknown");
  const missing = known.filter((s) => !cvTerms.has(s.term) && s.seen_count >= floor);
  const confirmed = known.filter((s) => cvTerms.has(s.term));
  const rising = signals.filter(
    (s) => s.category === "unknown" && s.seen_count >= UNKNOWN_REPORT_THRESHOLD,
  );

  return { sampleSize, missing, confirmed, rising, cvTermCount: cvTerms.size };
}

function pct(count: number, sample: number): string {
  if (sample <= 0) return `${count} postings`;
  return `${Math.round((count / sample) * 100)}% (${count}/${sample})`;
}

export function formatGapReport(report: GapReport): string {
  const { sampleSize, missing, confirmed, rising } = report;

  if (sampleSize === 0) {
    return (
      "CV GAPS — no data yet.\n\n" +
      "No posting has cleared the screening gates, so there is nothing to compare " +
      "the CV against. Run ingest_jobs first. Reporting gaps from zero passing " +
      "postings would be inventing a market."
    );
  }

  if (report.cvTermCount < MIN_CV_TERMS_FOR_GAPS) {
    return (
      `CV GAPS — cannot report gaps.\n\n` +
      `Only ${report.cvTermCount} recognisable skill term(s) were found in the CV document. ` +
      `A gap list is a claim about what the CV does NOT say, and against a CV this thin ` +
      `every one of the ${missing.length + confirmed.length} market terms would look ` +
      `"missing" — which would be a statement about the CV store, not about the market.\n\n` +
      `Fix the source first: start personal-rag (cd ~/Projects/personal-rag && ` +
      `uvicorn api:app --port 8765) or fill in the CV document, then run this again. ` +
      `Ingest and screening are unaffected and keep running.`
    );
  }

  const header =
    sampleSize < MIN_SAMPLE_FOR_PERCENTAGES
      ? `CV GAPS — built from ${sampleSize} passing posting(s).\n` +
        `⚠ TOO SMALL TO ACT ON. Below ${MIN_SAMPLE_FOR_PERCENTAGES} postings a single ` +
        `employer's wishlist looks like a market trend. Read this as a preview, not a finding.`
      : `CV GAPS — built from ${sampleSize} postings that cleared every hard gate.`;

  // The CV's own term count is the report's OTHER denominator. Printed because a
  // short MISSING list and a thin CV look identical without it.
  const basis = `Matched against ${report.cvTermCount} recognisable term(s) in your CV document.`;

  const sections: string[] = [];

  sections.push(
    missing.length === 0
      ? "MISSING — nothing frequent in the market is absent from the CV."
      : "MISSING — frequent in your reachable market, absent from your CV:\n" +
          missing
            .map((m) => `  · ${m.term.padEnd(22)} ${pct(m.seen_count, sampleSize)}  [${m.category}]`)
            .join("\n") +
          "\n  Some of these are real gaps. Some are things already built under another " +
          "name — check those first; a wording fix costs nothing.",
  );

  if (confirmed.length > 0) {
    sections.push(
      "CONFIRMED — in your CV and in demand:\n" +
        confirmed
          .slice(0, 15)
          .map((c) => `  · ${c.term.padEnd(22)} ${pct(c.seen_count, sampleSize)}`)
          .join("\n"),
    );
  }

  if (rising.length > 0) {
    sections.push(
      "RISING UNKNOWNS — recurring terms the dictionary doesn't know:\n" +
        rising
          .slice(0, 15)
          .map((r) => `  · ${r.term.padEnd(22)} ${r.seen_count} postings`)
          .join("\n") +
        "\n  Add the real technologies to src/tools/jobhunt/skills-dictionary.ts; " +
        "ignore the rest.",
    );
  }

  sections.push(
    "This report does not change your CV. It reports the difference and you decide " +
      "what is true.",
  );

  return `${header}\n${basis}\n\n${sections.join("\n\n")}`;
}

export const cvGapsTool: UnifiedTool = {
  name: "cv_gaps",
  description:
    "Compare the CV against what the screened job market actually asks for. Reports " +
    "skills frequent in postings that CLEARED the legal gates but missing from the CV, " +
    "skills confirmed in both, and recurring unrecognised terms. Use when the founder " +
    "asks what to add to the CV, what skills to learn, what the market wants, or how " +
    "the CV should change. SUGGESTS ONLY — never edits the CV. Read-only, no approval.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          "Narrow to one category: language, framework, infra, data, ai, practice.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const category = args["category"];

    let signals: SignalRow[];
    let sampleSize: number;
    try {
      const rows = await listSignals(
        typeof category === "string" && category.length > 0 ? { category } : {},
      );
      signals = rows.map((r) => ({
        term: r.term,
        category: r.category,
        seen_count: r.seen_count,
      }));
      sampleSize = await countPassingApplications();
    } catch (err) {
      return { success: false, error: `Signal store unreachable: ${(err as Error).message}` };
    }

    // The WHOLE CV, not a search result. read_cv answers a query and returns
    // matching excerpts; a gap report is a claim about what the CV does NOT say,
    // and absence can only be read off the complete document. An unreadable or
    // implausibly short CV fails loudly rather than making every term look missing.
    const cv = readFullCvText();
    if (!cv.ok) return { success: false, error: cv.error };

    const report = buildGapReport(signals, cv.text, sampleSize);
    log.info(
      { sampleSize, missing: report.missing.length, confirmed: report.confirmed.length },
      "CV gap report built",
    );
    return { success: true, data: formatGapReport(report) };
  },
};
