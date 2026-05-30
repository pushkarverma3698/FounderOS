/**
 * TDD — P4-HARD-4: Social pod warming state null guard.
 *
 * calculateWeeklyLimit(null) must NOT return NaN — returns 1 (safe minimum).
 * calculateWeeklyLimit(undefined) same.
 * calculateWeeklyLimit("invalid-date") same.
 * calculateWeeklyLimit(validDate) returns correct tier.
 */

import { describe, it, expect } from "vitest";
import { calculateWeeklyLimit, isPostingAllowed } from "../../../src/agents/pods/social.js";

describe("calculateWeeklyLimit — null guard (P4-HARD-4)", () => {
  it("returns 1 (safe minimum) when warmingStartedAt is null", () => {
    const result = calculateWeeklyLimit(null);
    expect(result).toBe(1);
    expect(result).not.toBeNaN();
  });

  it("returns 1 (safe minimum) when warmingStartedAt is undefined", () => {
    const result = calculateWeeklyLimit(undefined);
    expect(result).toBe(1);
    expect(result).not.toBeNaN();
  });

  it("returns 1 (safe minimum) when warmingStartedAt is an invalid date string", () => {
    const result = calculateWeeklyLimit("not-a-date");
    expect(result).toBe(1);
    expect(result).not.toBeNaN();
  });

  it("returns 1 for account in week 0 (started today)", () => {
    const today = new Date().toISOString();
    expect(calculateWeeklyLimit(today)).toBe(1);
  });

  it("returns 2 for account that is 1 week old", () => {
    const oneWeekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(calculateWeeklyLimit(oneWeekAgo)).toBe(2);
  });

  it("returns 999 (uncapped) for account older than 4 weeks", () => {
    const fiveWeeksAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    expect(calculateWeeklyLimit(fiveWeeksAgo)).toBe(999);
  });
});

describe("isPostingAllowed — uses null-guarded calculateWeeklyLimit", () => {
  it("allows posting for a mature account with 0 posts this week", () => {
    const fiveWeeksAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const warming = {
      warming_started_at: fiveWeeksAgo,
      posts_this_week: 0,
      total_posts: 10,
      last_post_date: null,
      platform: "linkedin" as const,
    };
    expect(isPostingAllowed(warming)).toBe(true);
  });

  it("blocks posting for a new account that has already posted this week", () => {
    const today = new Date().toISOString();
    const warming = {
      warming_started_at: today,
      posts_this_week: 1, // already at the limit (1/week for week 0)
      total_posts: 1,
      last_post_date: today,
      platform: "linkedin" as const,
    };
    expect(isPostingAllowed(warming)).toBe(false);
  });
});
