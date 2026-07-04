/**
 * Regression test for the LinkedIn 426 outage (prod 2026-07-04).
 * =============================================================
 * SYMPTOM: every LinkedIn post failed with HTTP 426
 *   "Requested version 20240501 is not active"
 * ROOT CAUSE: prod .env carried a stale, MALFORMED LINKEDIN_API_VERSION
 *   ("20240501" — a date, not the YYYYMM the API wants). It overrode the
 *   code default and the raw value went straight into the LinkedIn-Version
 *   header, so LinkedIn rejected every request.
 * FIX: resolveLinkedInApiVersion() accepts a version ONLY if it is exactly
 *   six digits (YYYYMM); anything else falls back to the known-good default.
 */

import { describe, it, expect } from "vitest";
import { resolveLinkedInApiVersion } from "../../../../src/infra/providers/linkedin-direct.js";

describe("resolveLinkedInApiVersion", () => {
  it("passes a well-formed YYYYMM version through unchanged", () => {
    expect(resolveLinkedInApiVersion("202606")).toBe("202606");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(resolveLinkedInApiVersion("  202511  ")).toBe("202511");
  });

  it("rejects the malformed dotted date that caused the prod 426", () => {
    // "20240501" is 8 digits, not YYYYMM — must be ignored, not forwarded.
    expect(resolveLinkedInApiVersion("20240501")).not.toBe("20240501");
    expect(resolveLinkedInApiVersion("20240501")).toMatch(/^\d{6}$/);
  });

  it("falls back to a valid default for empty / undefined / garbage", () => {
    for (const bad of [undefined, "", "   ", "latest", "2024-05", "v2"]) {
      expect(resolveLinkedInApiVersion(bad)).toMatch(/^\d{6}$/);
    }
  });
});
