/**
 * M0a — Evolution Engine v0: report renderer unit tests.
 * =======================================================
 * Unit tests covering Telegram report rendering, truncation limits,
 * header severity counts, and plain text safety.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ITEMS,
  MAX_EVIDENCE_CHARS,
  renderReport,
  SEVERITY_MARKERS,
  TELEGRAM_SAFE_CHARS,
} from "../../../src/evolution/report.js";
import type { Finding, FindingKind, Severity } from "../../../src/evolution/types.js";

const makeFinding = (
  subject: string,
  severity: Severity = "medium",
  evidence = `Evidence sentence for ${subject}.`,
  kind: FindingKind = "cost-hotspot",
): Finding => ({
  kind,
  subject,
  severity,
  evidence,
});

describe("renderReport", () => {
  it("returns exactly 'Self-audit: no findings.' for empty input", () => {
    expect(renderReport([])).toBe("Self-audit: no findings.");
  });

  it("calculates header counts correctly for a mixed-severity fixture", () => {
    const findings: Finding[] = [
      makeFinding("sub-1", "high"),
      makeFinding("sub-2", "high"),
      makeFinding("sub-3", "high"),
      makeFinding("sub-4", "medium"),
      makeFinding("sub-5", "medium"),
      makeFinding("sub-6", "low"),
    ];

    const report = renderReport(findings);

    expect(report).toContain("Self-audit: 6 findings (3 high, 2 medium, 1 low)");
  });

  it("says 'finding' not 'findings' for a single finding", () => {
    const report = renderReport([makeFinding("only-one", "high")]);

    expect(report).toContain("Self-audit: 1 finding (1 high, 0 medium, 0 low)");
  });

  it("includes every shown finding's evidence text in the output", () => {
    const findings: Finding[] = [
      makeFinding("sub-1", "high", "First evidence sentence."),
      makeFinding("sub-2", "medium", "Second evidence sentence."),
    ];

    const report = renderReport(findings);

    expect(report).toContain("First evidence sentence.");
    expect(report).toContain("Second evidence sentence.");
  });

  it("displays exactly 5 blocks and contains '+ 15 more' with 20 findings and maxItems: 5", () => {
    const findings: Finding[] = Array.from({ length: 20 }, (_, i) =>
      makeFinding(`subject-${i + 1}`, "medium", `Evidence text for finding ${i + 1}.`),
    );

    const report = renderReport(findings, { maxItems: 5 });

    // header + 5 blocks of [blank, title, evidence] + blank + withheld line
    expect(report.split("\n")).toHaveLength(1 + 5 * 3 + 2);
    expect(report).toContain("+ 15 more not shown (20 total).");
  });

  it("caps at DEFAULT_MAX_ITEMS when no maxItems is supplied", () => {
    const findings: Finding[] = Array.from({ length: DEFAULT_MAX_ITEMS + 4 }, (_, i) =>
      makeFinding(`subject-${i + 1}`, "medium", `Evidence text for finding ${i + 1}.`),
    );

    const report = renderReport(findings);

    expect(report).toContain(`subject-${DEFAULT_MAX_ITEMS}`);
    expect(report).not.toContain(`subject-${DEFAULT_MAX_ITEMS + 1}`);
    expect(report).toContain(`+ 4 more not shown (${DEFAULT_MAX_ITEMS + 4} total).`);
  });

  it("contains no 'more not shown' line when few findings fit completely", () => {
    const findings: Finding[] = [makeFinding("sub-1", "high"), makeFinding("sub-2", "low")];

    const report = renderReport(findings);

    expect(report).not.toContain("more not shown");
  });

  it("truncates oversized evidence but still shows the finding's severity and subject", () => {
    const hugeEvidence = "A".repeat(5000);
    const findings: Finding[] = [makeFinding("hugeSubject", "high", hugeEvidence)];

    const report = renderReport(findings);

    expect(report.length).toBeLessThan(TELEGRAM_SAFE_CHARS);
    expect(report).toContain("HIGH hugeSubject");
    expect(report).toContain("... (evidence truncated)");
    expect(report).not.toContain(hugeEvidence);
    // The whole point: a withheld high-severity row must never be the only signal.
    expect(report).not.toContain("more not shown");
  });

  it("leaves evidence at exactly MAX_EVIDENCE_CHARS untouched", () => {
    const exact = "B".repeat(MAX_EVIDENCE_CHARS);

    const report = renderReport([makeFinding("exactSubject", "low", exact)]);

    expect(report).toContain(exact);
    expect(report).not.toContain("evidence truncated");
  });

  it("stays under TELEGRAM_SAFE_CHARS when many findings each carry long evidence", () => {
    const findings: Finding[] = Array.from({ length: 12 }, (_, i) =>
      makeFinding(`subject-${i + 1}`, "high", "C".repeat(3000)),
    );

    const report = renderReport(findings);

    expect(report.length).toBeLessThan(TELEGRAM_SAFE_CHARS);
    expect(report).toContain("more not shown");
  });

  it("prints location only when it adds something the subject does not", () => {
    const withLocation: Finding = {
      kind: "dead-export",
      subject: "formatBrief",
      evidence: "formatBrief is exported and imported by no module.",
      severity: "medium",
      location: "src/proof/brief.ts",
    };
    const sameLocation: Finding = {
      kind: "loc-pressure",
      subject: "src/kernel/graph.ts",
      evidence: "src/kernel/graph.ts is 372 lines against a 400-line budget.",
      severity: "low",
      location: "src/kernel/graph.ts",
    };

    const report = renderReport([withLocation, sameLocation]);

    expect(report).toContain("MED formatBrief (src/proof/brief.ts)");
    expect(report).toContain("LOW src/kernel/graph.ts\n");
    expect(report).not.toContain("src/kernel/graph.ts (src/kernel/graph.ts)");
  });

  it("withholds everything but still says so when maxItems is zero", () => {
    const findings: Finding[] = [makeFinding("sub-1", "high"), makeFinding("sub-2", "low")];

    const report = renderReport(findings, { maxItems: 0 });

    expect(report).toContain("+ 2 more not shown (2 total).");
  });

  it("uses the exported severity markers", () => {
    const report = renderReport([makeFinding("sub-1", "high")]);

    expect(report).toContain(`${SEVERITY_MARKERS.high} sub-1`);
  });

  it("introduces no '<', '>', '*', or '_' formatting characters in renderer output", () => {
    const findings: Finding[] = [
      makeFinding("cleanSubject1", "high", "Plain evidence one."),
      makeFinding("cleanSubject2", "medium", "Plain evidence two."),
      makeFinding("cleanSubject3", "low", "Plain evidence three."),
    ];

    const report = renderReport(findings);

    expect(report).not.toMatch(/[<>*_]/);
  });
});
