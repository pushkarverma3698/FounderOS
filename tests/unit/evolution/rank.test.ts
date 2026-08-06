/**
 * M0a — Evolution Engine v0: findings ranker unit tests.
 * ========================================================
 * Unit tests covering total ordering over findings by severity, kind priority,
 * and subject.
 */

import { describe, expect, it } from "vitest";
import { KIND_PRIORITY, rankFindings, SEVERITY_RANK } from "../../../src/evolution/rank.js";
import type { Finding, FindingKind } from "../../../src/evolution/types.js";

const makeFinding = (
  kind: FindingKind,
  subject: string,
  severity: "high" | "medium" | "low",
  evidence = "Test evidence string.",
): Finding => ({
  kind,
  subject,
  severity,
  evidence,
});

describe("rankFindings", () => {
  it("sorts high above medium above low, regardless of input order", () => {
    const input: Finding[] = [
      makeFinding("loc-pressure", "module-c", "low"),
      makeFinding("cost-hotspot", "module-a", "high"),
      makeFinding("dead-export", "module-b", "medium"),
    ];

    const result = rankFindings(input);

    expect(result.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
    expect(result.map((f) => f.subject)).toEqual(["module-a", "module-b", "module-c"]);
  });

  it("decides by KIND_PRIORITY within the same severity: cost-hotspot above untested-module", () => {
    const input: Finding[] = [
      makeFinding("untested-module", "src/a.ts", "medium"),
      makeFinding("cost-hotspot", "admin:gemini-pro", "medium"),
      makeFinding("unapplied-lesson", "worker:SIG_ERR", "medium"),
    ];

    const result = rankFindings(input);

    expect(result.map((f) => f.kind)).toEqual([
      "unapplied-lesson",
      "cost-hotspot",
      "untested-module",
    ]);
  });

  it("reproduces the whole KIND_PRIORITY order, not just its endpoints", () => {
    // Ordering IS the product here, so pin every position: reordering any two
    // kinds in KIND_PRIORITY must fail a test, not slip through on the endpoints.
    // Same severity, and subjects deliberately reverse-alphabetical so that a
    // subject-first sort could not accidentally produce the expected answer.
    const reversed = [...KIND_PRIORITY].reverse();
    const input: Finding[] = reversed.map((kind, i) =>
      makeFinding(kind, `subject-${String(i).padStart(2, "0")}`, "medium"),
    );

    const result = rankFindings(input);

    expect(result.map((f) => f.kind)).toEqual([...KIND_PRIORITY]);
  });

  it("ranks severity high above medium above low", () => {
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
  });

  it("sorts subject alphabetically within the same severity and kind", () => {
    const input: Finding[] = [
      makeFinding("dead-export", "zebraExport", "low"),
      makeFinding("dead-export", "appleExport", "low"),
      makeFinding("dead-export", "bananaExport", "low"),
    ];

    const result = rankFindings(input);

    expect(result.map((f) => f.subject)).toEqual(["appleExport", "bananaExport", "zebraExport"]);
  });

  it("sorts an unknown kind absent from KIND_PRIORITY last without throwing", () => {
    const unknownKind = "future-unknown-kind" as FindingKind;
    const input: Finding[] = [
      makeFinding(unknownKind, "unknownSubject", "medium"),
      makeFinding("untested-module", "src/tested.ts", "medium"),
    ];

    const result = rankFindings(input);

    expect(result).toHaveLength(2);
    expect(result[0]?.kind).toBe("untested-module");
    expect(result[1]?.kind).toBe("future-unknown-kind" as FindingKind);
  });

  it("does NOT mutate the input array", () => {
    const input: Finding[] = [
      makeFinding("loc-pressure", "lowModule", "low"),
      makeFinding("cost-hotspot", "highModule", "high"),
    ];

    const copy = [...input];
    rankFindings(input);

    expect(input).toEqual(copy);
    expect(input[0]?.severity).toBe("low");
    expect(input[1]?.severity).toBe("high");
  });

  it("is deterministic: calling twice on the same input returns identical output", () => {
    const input: Finding[] = [
      makeFinding("dead-export", "b", "medium"),
      makeFinding("cost-hotspot", "a", "high"),
      makeFinding("untested-module", "c", "low"),
      makeFinding("dead-export", "a", "medium"),
    ];

    const firstRun = rankFindings(input);
    const secondRun = rankFindings(input);

    expect(firstRun).toEqual(secondRun);
  });
});
