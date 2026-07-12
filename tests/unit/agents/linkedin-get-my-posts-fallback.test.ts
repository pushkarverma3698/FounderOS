/**
 * linkedin_get_my_posts — audit-log fallback must carry POST TEXT.
 * LIVE FAILURE 2026-07-12 (turns 68eae59d, 64ba4004): the founder asked
 * "read previous LinkedIn posts and summarise"; the LinkedIn read API 403s
 * (token lacks r_member_social) and the fallback returned bare URNs — nothing
 * to summarise. FounderOS POSTED those posts itself: action_log payload holds
 * the text (verified on prod agents.action_log 2026-07-12). The fallback must
 * surface it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetMyPostsExecute, mockRecentPosts } = vi.hoisted(() => ({
  mockGetMyPostsExecute: vi.fn(),
  mockRecentPosts: vi.fn(),
}));

vi.mock("../../../src/tools/linkedin-engagement.js", () => ({
  linkedinGetMyPostsTool: { execute: (...a: unknown[]) => mockGetMyPostsExecute(...a) },
  linkedinReadCommentsTool: { execute: vi.fn() },
}));

vi.mock("../../../src/db/queries.js", () => ({
  createInterrupt: vi.fn(async () => "test-interrupt-id"),
  getPendingInterrupt: vi.fn(async () => null),
  hasRecentOutboundToRecipient: vi.fn(async () => false),
  isSuppressed: vi.fn(async () => false),
  getDailyOutboundCount: vi.fn(async () => 0),
  getRecentLinkedInPostIds: vi.fn(async () => []),
  getRecentLinkedInPosts: (...a: unknown[]) => mockRecentPosts(...a),
  listUpcomingScheduledPosts: vi.fn(async () => []),
}));

const { linkedinGetMyPosts } = await import("../../../src/agents/agent-tools/comms.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linkedin_get_my_posts audit-log fallback", () => {
  it("includes the post text from action_log so 'summarise my posts' has content (64ba4004)", async () => {
    mockGetMyPostsExecute.mockResolvedValue({
      success: false,
      error: "LinkedIn read access denied (403). Fetching your posts requires r_member_social scope.",
    });
    mockRecentPosts.mockResolvedValue([
      {
        post_id: "urn:li:share:7480237752614203393",
        text: "The new wave of AI models (Gemini 2.5, Claude 5) have incredible reasoning power.",
        at: "2026-07-08T10:00:00Z",
      },
      {
        post_id: "urn:li:share:7479297391603478528",
        text: "Why do 80% of AI startups struggle with launch?",
        at: "2026-07-05T10:00:00Z",
      },
    ]);

    const out = (await linkedinGetMyPosts.invoke({ limit: 5 })) as string;

    expect(out).toContain("urn:li:share:7480237752614203393");
    expect(out).toContain("incredible reasoning power");
    expect(out).toContain("Why do 80% of AI startups struggle");
  });

  it("still explains next steps when the audit log is empty too", async () => {
    mockGetMyPostsExecute.mockResolvedValue({ success: false, error: "403" });
    mockRecentPosts.mockResolvedValue([]);

    const out = (await linkedinGetMyPosts.invoke({ limit: 5 })) as string;

    expect(out).toMatch(/post via FounderOS|r_member_social/i);
  });
});
