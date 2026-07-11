import { describe, expect, it } from "vitest";
import {
  LINKEDIN_POSTING_FLOWS,
  prepareLinkedInFeedPost,
  resolveLinkedInPostingPolicy,
} from "../../../src/core/linkedin-posting-policy.js";

describe("linkedin-posting-policy", () => {
  it("covers every flow constant", () => {
    for (const flow of LINKEDIN_POSTING_FLOWS) {
      expect(resolveLinkedInPostingPolicy(flow).flow).toBe(flow);
    }
  });

  it("scheduled_feed uses personal account + company tag", () => {
    const p = resolveLinkedInPostingPolicy("scheduled_feed");
    expect(p.account_key).toBe("personal");
    expect(p.tag_company_page).toBe(true);
  });

  it("immediate_feed and engagement use turicks company page", () => {
    expect(resolveLinkedInPostingPolicy("immediate_feed").account_key).toBe("turicks");
    expect(resolveLinkedInPostingPolicy("immediate_feed").tag_company_page).toBe(false);
    expect(resolveLinkedInPostingPolicy("engagement").account_key).toBe("turicks");
  });

  it("outreach_note uses personal without tag", () => {
    const p = resolveLinkedInPostingPolicy("outreach_note");
    expect(p.account_key).toBe("personal");
    expect(p.tag_company_page).toBe(false);
  });

  it("prepareLinkedInFeedPost tags scheduled personal posts", () => {
    const { text, account_key, policy } = prepareLinkedInFeedPost("Hello world", "scheduled_feed");
    expect(account_key).toBe("personal");
    expect(policy.tag_company_page).toBe(true);
    expect(text).toContain("@Turicks");
  });
});
