/**
 * TDD — ICP scorer prompt coverage tests.
 *
 * These tests verify that the ICP_SCORER system prompt covers all the verticals
 * and calibration examples needed to correctly score real-world prospects.
 *
 * Motivation:
 *   The previous ICP_SCORER prompt only listed EdTech/HRTech/FinTech/PropTech/B2B SaaS.
 *   Design tool SaaS companies (like Framer) were scored as "adjacent" (0.5 vertical fit)
 *   instead of "exact match" (1.0), causing Framer to score below 0.70 CEO threshold.
 *
 * Tests are deterministic (no LLM calls) — they inspect the prompt text directly.
 * This lets us validate prompt coverage instantly without burning API tokens.
 */

import { describe, it, expect } from "vitest";
import { getSystem } from "../../src/core/prompts.js";

describe("ICP_SCORER prompt coverage", () => {
  const prompt = getSystem("ICP_SCORER");

  // ── Vertical coverage ──────────────────────────────────────────────────────
  it("includes Design Tool SaaS as a recognized ICP vertical", () => {
    // Framer, Figma-alternatives, design system tools — all strong Turicks ICP
    expect(prompt.toLowerCase()).toContain("design tool");
  });

  it("calls out AI-first pivot as a scoring signal", () => {
    // Companies pivoting to AI (like Framer) should get extra signal weight
    expect(prompt.toLowerCase()).toContain("ai-first");
  });

  // ── Calibration examples ───────────────────────────────────────────────────
  it("includes a design-tool company as a calibration example", () => {
    // Without a concrete example, models under-weight design tool companies
    // The example should demonstrate a score >= 0.70 for a design SaaS
    expect(prompt.toLowerCase()).toMatch(/framer|figma|design.*tool.*0\.[7-9]/i);
  });

  it("calibration example shows design+AI company at CEO tier (>=0.70)", () => {
    // The score shown in the calibration example must be 0.70 or higher
    // so the model is calibrated to route them to CEO tier
    const designMatch = prompt.match(/framer.*?0\.(\d+)/is) ?? prompt.match(/design.*?0\.(\d+)/is);
    expect(designMatch).not.toBeNull();
    if (designMatch) {
      const score = parseFloat(`0.${designMatch[1]}`);
      expect(score).toBeGreaterThanOrEqual(0.7);
    }
  });

  // ── Existing verticals still present ──────────────────────────────────────
  it("still includes EdTech, FinTech, HRTech as ICP verticals", () => {
    expect(prompt).toContain("EdTech");
    expect(prompt).toContain("FinTech");
    expect(prompt).toContain("HRTech");
  });
});
