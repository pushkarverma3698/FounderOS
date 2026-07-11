/**
 * Session E2E — LinkedIn account policy + marketing agent tools (deterministic, $0).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  prepareLinkedInFeedPost,
  resolveLinkedInPostingPolicy,
} from "../../../src/core/linkedin-posting-policy.js";
import { appendCompanyPageMention } from "../../../src/infra/social-mention.js";

const { mockInterrupt, mockPostExecute, mockAnalyticsExecute } = vi.hoisted(() => ({
  mockInterrupt: vi.fn(),
  mockPostExecute: vi.fn(),
  mockAnalyticsExecute: vi.fn(),
}));

vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: mockInterrupt };
});

vi.mock("../../../src/tools/linkedin.js", () => ({
  linkedinPostTool: { execute: (...a: unknown[]) => mockPostExecute(...a) },
  linkedinAnalyticsTool: { execute: (...a: unknown[]) => mockAnalyticsExecute(...a) },
}));

vi.mock("../../../src/db/queries.js", () => ({
  createInterrupt: vi.fn(async () => "test-interrupt-id"),
  getPendingInterrupt: vi.fn(async () => null),
  hasRecentOutboundToRecipient: vi.fn(async () => false),
  isSuppressed: vi.fn(async () => false),
  getDailyOutboundCount: vi.fn(async () => 0),
  getRecentLinkedInPostIds: vi.fn(async () => ["urn:li:share:99"]),
}));

const GOOD_HOOK = "7 founders told me they can't hire a dev team.";
const GOOD_BODY = `
We built FounderOS in 3 weeks. Here's exactly what we shipped:

- Telegram-native AI operating system for solo founders
- Six departments: research, comms, engineering, marketing, sales, prospecting
- Human-in-the-loop approval before every external action (emails, LinkedIn posts, GitHub writes)
- LangGraph checkpointing for crash-safe HITL recovery

The whole thing is roughly 500 lines of orchestration because we used prebuilt LangGraph primitives instead of writing custom supervisor loops from scratch.

Most agencies charging for AI automation are delivering slide decks. We deliver working, production-grade systems that run on Telegram and cost less than a part-time hire.

This week I used it to check my inbox, draft a cold outreach email, score a prospect against our ICP, and push a GitHub issue — all from Telegram, all approved before anything went out.

What's the most painful part of running your agency without a full-time tech team?
`.trim();
const VALID_LINKEDIN_POST = `${GOOD_HOOK}\n\n${GOOD_BODY}`;

describe("session E2E — LinkedIn account & growth policy", () => {
  it("immediate_feed uses turicks company page without @tag", () => {
    const policy = resolveLinkedInPostingPolicy("immediate_feed");
    const { text, account_key } = prepareLinkedInFeedPost("Official Turicks update.", "immediate_feed");
    expect(policy.account_key).toBe("turicks");
    expect(account_key).toBe("turicks");
    expect(text).not.toContain("@Turicks");
  });

  it("scheduled_feed uses personal account with @Turicks appended", () => {
    const { text, account_key, policy } = prepareLinkedInFeedPost(
      "I solved agent hallucination sends with FounderOS.",
      "scheduled_feed",
    );
    expect(account_key).toBe("personal");
    expect(policy.tag_company_page).toBe(true);
    expect(text).toContain("@Turicks");
    expect(text).toContain("FounderOS");
  });

  it("outreach_note policy is personal without company tag", () => {
    const p = resolveLinkedInPostingPolicy("outreach_note");
    expect(p.account_key).toBe("personal");
    expect(p.tag_company_page).toBe(false);
  });

  it("appendCompanyPageMention is idempotent", () => {
    const once = appendCompanyPageMention("Build log post", "Turicks");
    const twice = appendCompanyPageMention(once, "Turicks");
    expect(twice).toBe(once);
  });
});

describe("session E2E — marketing agent LinkedIn tools", () => {
  let savedAnthropic: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { _resetBrandRetries } = await import("../../../src/infra/brand-retry.js");
    _resetBrandRetries();
    savedAnthropic = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    mockInterrupt.mockReturnValue("approved");
    mockPostExecute.mockResolvedValue({
      success: true,
      data: { post_id: "urn:li:share:agent1" },
    });
    mockAnalyticsExecute.mockResolvedValue({
      success: true,
      data: { reactions: 42, comments: 7, impressions: 1200 },
    });
  });

  afterEach(() => {
    if (savedAnthropic !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropic;
  });

  it("linkedin_post publishes via turicks account_key after HITL approval", async () => {
    const { linkedinPost } = await import("../../../src/agents/agent-tools/comms.js");
    const out = await linkedinPost.invoke(
      { text: VALID_LINKEDIN_POST },
      { configurable: { thread_id: "e2e-post-turicks" } },
    );

    expect(out).toMatch(/LinkedIn post published/);
    expect(out).toMatch(/Turicks company page|company page/i);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
    expect(mockPostExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        account_key: "turicks",
        department: "marketing",
        tenant_id: "turicks",
      }),
    );
    const call = mockPostExecute.mock.calls[0]![0] as { text: string };
    expect(call.text).not.toContain("@Turicks");
  });

  it("linkedin_analytics returns formatted metrics without HITL", async () => {
    const { linkedinAnalytics } = await import("../../../src/agents/agent-tools/comms.js");
    const out = await linkedinAnalytics.invoke({ post_id: "urn:li:share:99" });

    expect(out).toMatch(/reactions: 42/);
    expect(out).toMatch(/comments: 7/);
    expect(mockAnalyticsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ post_id: "urn:li:share:99", tenant_id: "turicks" }),
    );
    expect(mockInterrupt).not.toHaveBeenCalled();
  });

  it("linkedin_analytics surfaces provider errors cleanly", async () => {
    mockAnalyticsExecute.mockResolvedValueOnce({ success: false, error: "403 scope missing" });
    const { linkedinAnalytics } = await import("../../../src/agents/agent-tools/comms.js");
    const out = await linkedinAnalytics.invoke({ post_id: "urn:li:share:bad" });
    expect(out).toMatch(/LinkedIn analytics failed: 403 scope missing/);
  });
});
