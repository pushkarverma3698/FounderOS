import { describe, it, expect, vi } from "vitest";
import { generateDorks } from "../../src/tools/b2b/dork-generator";
import { scoreCandidate } from "../../src/tools/b2b/rule-extractor";

describe("b2b discovery", () => {
  it("generates 4 dorks", () => {
    const dorks = generateDorks("Stripe");
    expect(dorks).toHaveLength(4);
    expect(dorks[0]).toContain("Stripe");
  });

  it("scores candidate deterministically", () => {
    const candidate = scoreCandidate(
      {
        link: "https://linkedin.com/in/john-doe",
        title: "John Doe - Technical Recruiter - Stripe",
        snippet: "I am a technical recruiter at Stripe."
      },
      "Stripe"
    );
    expect(candidate).not.toBeNull();
    expect(candidate?.confidence).toBeGreaterThan(0.85);
    expect(candidate?.method).toBe("title-parse");
  });
});
