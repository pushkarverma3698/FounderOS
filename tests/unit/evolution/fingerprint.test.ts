/**
 * M0a — Evolution Engine v0: finding fingerprint unit tests.
 * =============================================================
 * Pins the identity contract src/evolution/persist-findings.ts depends on:
 * same (kind, location, subject) → same fingerprint, always; a change to any
 * of the three → a different one; `evidence` never affects it at all.
 */

import { describe, expect, it } from "vitest";
import { computeFingerprint, normalizeIdentityPart } from "../../../src/evolution/fingerprint.js";
import type { Finding } from "../../../src/evolution/types.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: "dead-export",
  subject: "buildLessonStore",
  evidence: "\"buildLessonStore\" is exported from src/x.ts but appears exactly once.",
  severity: "low",
  location: "src/x.ts",
  ...over,
});

describe("computeFingerprint", () => {
  it("is deterministic — same input, same output, every call", () => {
    const f = finding();
    expect(computeFingerprint(f)).toBe(computeFingerprint(f));
    expect(computeFingerprint({ ...f })).toBe(computeFingerprint({ ...f }));
  });

  it("is a 64-char lowercase hex sha256 digest", () => {
    const fp = computeFingerprint(finding());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT change when only evidence changes — the whole point of excluding it", () => {
    const a = computeFingerprint(finding({ evidence: "occurs 3 times, costs $1.20" }));
    const b = computeFingerprint(finding({ evidence: "occurs 4 times, costs $9.99 — totally different wording" }));
    expect(a).toBe(b);
  });

  it("does NOT change when only severity changes", () => {
    const a = computeFingerprint(finding({ severity: "low" }));
    const b = computeFingerprint(finding({ severity: "high" }));
    expect(a).toBe(b);
  });

  it("changes when kind changes, subject/location held equal", () => {
    const a = computeFingerprint(finding({ kind: "dead-export" }));
    const b = computeFingerprint(finding({ kind: "untested-module" }));
    expect(a).not.toBe(b);
  });

  it("changes when subject changes, kind/location held equal — two dead-exports in the same file must not collide", () => {
    const a = computeFingerprint(finding({ subject: "symbolA" }));
    const b = computeFingerprint(finding({ subject: "symbolB" }));
    expect(a).not.toBe(b);
  });

  it("changes when location changes, kind/subject held equal", () => {
    const a = computeFingerprint(finding({ location: "src/a.ts" }));
    const b = computeFingerprint(finding({ location: "src/b.ts" }));
    expect(a).not.toBe(b);
  });

  it("treats a missing location as distinct from a present one (unused-dependency has none)", () => {
    const withLocation = computeFingerprint(finding({ location: "src/a.ts" }));
    const withoutLocation = computeFingerprint(finding({ location: undefined }));
    expect(withLocation).not.toBe(withoutLocation);
  });

  it("two different findings with no location (unused-dependency-shaped) do not collide", () => {
    const a = computeFingerprint({ kind: "unused-dependency", subject: "lodash", evidence: "e", severity: "medium" });
    const b = computeFingerprint({ kind: "unused-dependency", subject: "axios", evidence: "e", severity: "medium" });
    expect(a).not.toBe(b);
  });

  it("is immune to trailing whitespace and a trailing slash — the cosmetic noise these fields can carry", () => {
    const a = computeFingerprint(finding({ location: "src/outreach/" }));
    const b = computeFingerprint(finding({ location: "src/outreach" }));
    expect(a).toBe(b);

    const c = computeFingerprint(finding({ subject: "  symbolA  " }));
    const d = computeFingerprint(finding({ subject: "symbolA" }));
    expect(c).toBe(d);
  });

  it("does not let a shifted boundary between fields forge a collision", () => {
    // kind="a", location="bc" vs kind="ab", location="c" — a naive plain-concat
    // join would hash both to "abc"; the separator must prevent that.
    const a = computeFingerprint({ kind: "dead-export" as Finding["kind"], location: "bc", subject: "s", evidence: "", severity: "low" });
    const b = computeFingerprint({ kind: "dead-export" as Finding["kind"], location: "c", subject: "s", evidence: "", severity: "low" });
    expect(a).not.toBe(b);
  });
});

describe("normalizeIdentityPart", () => {
  it("trims, collapses internal whitespace, and drops a trailing slash", () => {
    expect(normalizeIdentityPart("  src/dir  ")).toBe("src/dir");
    expect(normalizeIdentityPart("src/dir/")).toBe("src/dir");
    expect(normalizeIdentityPart("a   b")).toBe("a b");
  });

  it("leaves an already-clean value unchanged", () => {
    expect(normalizeIdentityPart("buildLessonStore")).toBe("buildLessonStore");
  });
});
