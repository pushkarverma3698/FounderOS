/**
 * Unit tests for LinkedIn engagement assist tools.
 * These are read-only (comments) + draft-only (reply/connection note) — no auto-send.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderLinkedInReadComments = vi.fn();

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerLinkedInReadComments: mockProviderLinkedInReadComments,
}));

vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { linkedinReadCommentsTool } = await import("../../../src/tools/linkedin-engagement.js");

describe("linkedinReadCommentsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns comments on success", async () => {
    mockProviderLinkedInReadComments.mockResolvedValue({
      success: true,
      data: {
        post_id: "urn:li:share:123",
        comments: [
          { id: "c1", author_urn: "urn:li:person:A", text: "Great post!", created_at: 1700000000000 },
          { id: "c2", author_urn: "urn:li:person:B", text: "Very insightful.", created_at: 1700001000000 },
        ],
        total: 2,
      },
    });

    const result = await linkedinReadCommentsTool.execute({ post_id: "urn:li:share:123" });

    expect(result.success).toBe(true);
    const data = result.data as { comments: unknown[]; total: number };
    expect(data.comments).toHaveLength(2);
    expect(data.total).toBe(2);
  });

  it("returns success: false with a scope hint when provider returns 403", async () => {
    mockProviderLinkedInReadComments.mockResolvedValue({
      success: false,
      error:
        "LinkedIn read access denied (403). Reading comments requires r_member_social scope.",
    });

    const result = await linkedinReadCommentsTool.execute({ post_id: "urn:li:share:999" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("r_member_social");
  });

  it("returns success: false on network error", async () => {
    mockProviderLinkedInReadComments.mockResolvedValue({
      success: false,
      error: "fetch failed: ECONNREFUSED",
    });

    const result = await linkedinReadCommentsTool.execute({ post_id: "urn:li:share:abc" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fetch failed");
  });

  it("passes limit to provider", async () => {
    mockProviderLinkedInReadComments.mockResolvedValue({ success: true, data: { comments: [], total: 0 } });

    await linkedinReadCommentsTool.execute({ post_id: "urn:li:share:123", limit: 5 });

    expect(mockProviderLinkedInReadComments).toHaveBeenCalledWith("urn:li:share:123", { limit: 5 });
  });

  it("calls provider with no limit when omitted", async () => {
    mockProviderLinkedInReadComments.mockResolvedValue({ success: true, data: { comments: [], total: 0 } });

    await linkedinReadCommentsTool.execute({ post_id: "urn:li:share:123" });

    expect(mockProviderLinkedInReadComments).toHaveBeenCalledWith("urn:li:share:123", { limit: undefined });
  });
});
