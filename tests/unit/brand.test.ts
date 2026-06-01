/**
 * RED tests for brand voice validation utilities.
 * Tests run against the brandVoice module (to be implemented in src/core/brand.ts).
 */

import { describe, it, expect } from "vitest";
import { containsBannedPhrase, validateChannelLength, validateLinkedInPost } from "../../src/core/brand.js";

describe("containsBannedPhrase", () => {
  it('flags "excited to share"', () => {
    expect(containsBannedPhrase("I'm excited to share our new product")).toBe(true);
  });

  it('flags "game-changer"', () => {
    expect(containsBannedPhrase("This is a game-changer for the industry")).toBe(true);
  });

  it('flags "synergy"', () => {
    expect(containsBannedPhrase("We need to leverage synergy across teams")).toBe(true);
  });

  it('flags "I wanted to reach out"', () => {
    expect(containsBannedPhrase("Hi John, I wanted to reach out about your product")).toBe(true);
  });

  it('flags "Hope this finds you well"', () => {
    expect(containsBannedPhrase("Hope this finds you well! Quick question:")).toBe(true);
  });

  it("passes clean brand-voice copy", () => {
    expect(containsBannedPhrase("We cut your lead qualification time by 60%.")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(containsBannedPhrase("This is a Game-Changer for SaaS")).toBe(true);
  });
});

describe("validateChannelLength", () => {
  const shortText = "word ".repeat(10).trim(); // 10 words ~50 chars
  const linkedinOk = "word ".repeat(200).trim(); // 200 words — within 150-300
  const linkedinTooLong = "word ".repeat(350).trim(); // 350 words — over 300
  const linkedinTooShort = "word ".repeat(100).trim(); // 100 words — under 150
  const outreachOk = "word ".repeat(100).trim(); // 100 words — under 150
  const outreachTooLong = "word ".repeat(200).trim(); // 200 words — over 150

  it("linkedin post within 150-300 words passes", () => {
    expect(validateChannelLength("linkedin", linkedinOk)).toBe(true);
  });

  it("linkedin post over 300 words fails", () => {
    expect(validateChannelLength("linkedin", linkedinTooLong)).toBe(false);
  });

  it("linkedin post under 150 words fails", () => {
    expect(validateChannelLength("linkedin", linkedinTooShort)).toBe(false);
  });

  it("outreach email under 150 words passes", () => {
    expect(validateChannelLength("outreach", outreachOk)).toBe(true);
  });

  it("outreach email over 150 words fails", () => {
    expect(validateChannelLength("outreach", outreachTooLong)).toBe(false);
  });

  it("instagram caption under 150 words passes", () => {
    expect(validateChannelLength("instagram", shortText)).toBe(true);
  });
});

describe("validateLinkedInPost", () => {
  it("fails if no hook on line 1 (no number, no question, no counterintuitive claim)", () => {
    const post = "We are happy to share our latest update.\n\nPlease check it out.";
    const result = validateLinkedInPost(post);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("missing_hook");
  });

  it("passes if line 1 contains a number", () => {
    const post = "3 reasons your LinkedIn outreach is getting ignored.\n\nFirst, you're leading with your product.\n\nSecond, you're not being specific.\n\nThird, you're using banned phrases.\n\nFix these and your reply rate will climb.";
    const result = validateLinkedInPost(post);
    expect(result.violations).not.toContain("missing_hook");
  });

  it("fails if contains banned phrase", () => {
    const post = "7 things I wish I knew.\n\nExcited to share that we just launched.\n\nMore details below.";
    const result = validateLinkedInPost(post);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("banned_phrase");
  });
});
