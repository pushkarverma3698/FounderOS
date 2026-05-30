/**
 * TDD — safeParseJson robustness tests.
 *
 * safeParseJson must handle every real-world LLM output pattern:
 *   1. Clean JSON — fast path
 *   2. Markdown-fenced JSON — strip fences first
 *   3. Explanation text BEFORE the JSON — extract first {...} block
 *   4. Explanation text AFTER the JSON — stop at closing brace
 *   5. TWO consecutive JSON objects — take the FIRST one, ignore the rest (regression)
 *   6. Malformed JSON with trailing comma — jsonrepair fixes it
 *   7. Completely non-JSON prose — return null, never throw
 *
 * Regression: Ollama models sometimes emit the JSON followed by a second
 * explanation block `{"note": "..."}`. The greedy regex `/\{[\s\S]*\}/`
 * captures both, causing JSON.parse to fail with:
 *   "Unexpected non-whitespace character after JSON at position N"
 * The fix uses bracket-counting to extract only the FIRST balanced {...} block.
 */

import { describe, it, expect } from "vitest";

// safeParseJson is exported from llm.ts — we import it directly.
// DB / Redis / config don't need to be mocked because safeParseJson is a
// pure function with no I/O: it takes a string, returns parsed object | null.

// ── Import safeParseJson ───────────────────────────────────────────────────────
// We need to isolate the pure helper without triggering all the cascade setup.
// vitest module isolation handles this cleanly.

import { safeParseJson } from "../../src/infra/llm.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("safeParseJson", () => {
  // ── 1. Clean JSON ────────────────────────────────────────────────────────────
  it("parses clean JSON — fast path", () => {
    const input = '{"icp_score": 0.75, "outreach_tier": "ceo"}';
    const result = safeParseJson<{ icp_score: number }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.75);
  });

  // ── 2. Markdown-fenced JSON ──────────────────────────────────────────────────
  it("strips ```json``` fences before parsing", () => {
    const input = "```json\n{\"icp_score\": 0.5}\n```";
    const result = safeParseJson<{ icp_score: number }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.5);
  });

  it("strips plain ``` fences before parsing", () => {
    const input = "```\n{\"icp_score\": 0.8}\n```";
    const result = safeParseJson<{ icp_score: number }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.8);
  });

  // ── 3. Prose before JSON ─────────────────────────────────────────────────────
  it("extracts JSON when model prepends explanation text", () => {
    const input = "Here is the ICP score analysis:\n\n{\"icp_score\": 0.72, \"outreach_tier\": \"ceo\"}";
    const result = safeParseJson<{ icp_score: number; outreach_tier: string }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.72);
    expect(result!.outreach_tier).toBe("ceo");
  });

  // ── 4. Prose after JSON ──────────────────────────────────────────────────────
  it("ignores trailing prose after the closing brace", () => {
    const input = '{"icp_score": 0.65}\nThat concludes my analysis.';
    const result = safeParseJson<{ icp_score: number }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.65);
  });

  // ── 5. TWO consecutive JSON objects (Ollama regression) ──────────────────────
  //
  // Ollama models sometimes emit the response JSON followed by an explanation
  // JSON block. The greedy regex was capturing BOTH, failing JSON.parse.
  //
  it("returns FIRST JSON object when LLM emits two consecutive objects", () => {
    const input = [
      '{"icp_score": 0.78, "outreach_tier": "ceo", "top_pain": "scaling ops"}',
      '{"note": "This company is a strong fit for Turicks AI agency services."}',
    ].join("\n\n");

    const result = safeParseJson<{ icp_score: number; outreach_tier: string }>(input);
    expect(result).not.toBeNull();
    // Must get the ICP score from the FIRST object, not the note from the second
    expect(result!.icp_score).toBe(0.78);
    expect(result!.outreach_tier).toBe("ceo");
  });

  it("handles multi-line JSON followed by a second JSON block", () => {
    const input = `{
  "icp_score": 0.82,
  "icp_rationale": "Strong design tool with AI pivot",
  "budget_signal": "high",
  "outreach_tier": "ceo",
  "disqualify_reason": null,
  "top_pain": "designer onboarding"
}
{
  "extra_note": "Framer is an excellent prospect"
}`;

    const result = safeParseJson<{ icp_score: number }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.82);
  });

  // ── 6. Malformed JSON — jsonrepair ───────────────────────────────────────────
  it("repairs trailing commas via jsonrepair", () => {
    const input = '{"icp_score": 0.7, "outreach_tier": "md",}';
    const result = safeParseJson<{ icp_score: number }>(input);
    expect(result).not.toBeNull();
    expect(result!.icp_score).toBe(0.7);
  });

  // ── 7. Non-JSON prose — return null, never throw ─────────────────────────────
  it("returns null for pure prose input — never throws", () => {
    expect(() => {
      const result = safeParseJson("This is just a plain English response with no JSON.");
      expect(result).toBeNull();
    }).not.toThrow();
  });

  it("returns null for empty string — never throws", () => {
    expect(() => {
      const result = safeParseJson("");
      expect(result).toBeNull();
    }).not.toThrow();
  });
});
