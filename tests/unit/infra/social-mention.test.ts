import { describe, expect, it } from "vitest";
import { appendCompanyPageMention } from "../../../src/infra/social-mention.js";

describe("social-mention", () => {
  it("appends @Turicks when missing", () => {
    const out = appendCompanyPageMention("Shipped FounderOS this week.", "Turicks");
    expect(out).toContain("Shipped FounderOS this week.");
    expect(out.endsWith("@Turicks")).toBe(true);
  });

  it("does not duplicate existing mention", () => {
    const text = "Great week @Turicks";
    expect(appendCompanyPageMention(text, "Turicks")).toBe(text);
  });

  it("is case-insensitive for duplicate detection", () => {
    const text = "Follow @turicks for updates";
    expect(appendCompanyPageMention(text, "Turicks")).toBe(text);
  });
});
