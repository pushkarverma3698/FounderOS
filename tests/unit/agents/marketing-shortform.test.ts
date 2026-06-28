/**
 * Regression test for B1 (HARD-BATTERY-2026-06-29 H08).
 *
 * Bug: founder asked for a SHORT (3-line) LinkedIn DRAFT ("don't send, just
 * show me"). The marketing dept REFUSED: "My instructions require LinkedIn
 * posts to be 150–300 words." That is wrong — when the founder explicitly
 * requests short-form and only a draft, the dept must DRAFT it and FLAG the
 * brand-length deviation, never refuse. The founder is the gate.
 *
 * This is a prompt-policy bug (B1 is the documented exception to rule #16):
 * the override lives in MARKETING_PROMPT. This test pins the override
 * language so the refuse-on-length framing can never silently return.
 */

import { describe, it, expect } from "vitest";
import { MARKETING_PROMPT } from "../../../src/agents/system-prompts.js";

describe("MARKETING_PROMPT — explicit short-form draft override (B1)", () => {
  it("keeps 150–300 words as the DEFAULT, not a hard floor", () => {
    expect(MARKETING_PROMPT).toContain("DEFAULT brand length");
    expect(MARKETING_PROMPT).toContain("NOT a floor you may refuse over");
  });

  it("instructs DRAFT-on-explicit-request instead of refusing", () => {
    expect(MARKETING_PROMPT).toContain(
      "DRAFT exactly the length they asked for",
    );
    expect(MARKETING_PROMPT).toMatch(/NEVER refuse a draft because it is shorter or longer/);
  });

  it("includes the brand-length deviation flag wording", () => {
    expect(MARKETING_PROMPT).toContain(
      "shorter than our usual 150–300-word brand length, drafted as you requested",
    );
  });

  it("names the founder as the gate", () => {
    expect(MARKETING_PROMPT).toContain("the founder is the gate");
  });
});
