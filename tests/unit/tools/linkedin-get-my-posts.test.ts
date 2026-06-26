/**
 * Tests for linkedinGetMyPostsTool — API path + action_log fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerLinkedInGetMyPosts: vi.fn(),
  providerLinkedInReadComments: vi.fn(),
}));

vi.mock("../../../src/infra/providers/linkedin-direct.js", () => ({
  directLinkedInGetMyPosts: vi.fn(),
}));

import { linkedinGetMyPostsTool } from "../../../src/tools/linkedin-engagement.js";
import { providerLinkedInGetMyPosts } from "../../../src/infra/providers/index.js";

const mockGet = vi.mocked(providerLinkedInGetMyPosts);

beforeEach(() => vi.clearAllMocks());

describe("linkedinGetMyPostsTool", () => {
  it("returns posts on success", async () => {
    mockGet.mockResolvedValueOnce({
      success: true,
      data: {
        posts: [
          { id: "urn:li:share:111", text: "Hello world post", created_at: 1000 },
          { id: "urn:li:share:222", text: "Second post", created_at: 900 },
        ],
      },
    });
    const res = await linkedinGetMyPostsTool.execute({ limit: 2 });
    expect(res.success).toBe(true);
    const data = res.data as { posts: Array<{ id: string }> };
    expect(data.posts).toHaveLength(2);
    expect(data.posts[0]!.id).toBe("urn:li:share:111");
  });

  it("returns 403 scope error when not authorised", async () => {
    mockGet.mockResolvedValueOnce({
      success: false,
      error: "LinkedIn read access denied (403). Fetching your posts requires r_member_social scope.",
    });
    const res = await linkedinGetMyPostsTool.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/r_member_social/);
  });

  it("passes limit to provider", async () => {
    mockGet.mockResolvedValueOnce({ success: true, data: { posts: [] } });
    await linkedinGetMyPostsTool.execute({ limit: 10 });
    expect(mockGet).toHaveBeenCalledWith({ limit: 10 });
  });

  it("passes no limit when omitted", async () => {
    mockGet.mockResolvedValueOnce({ success: true, data: { posts: [] } });
    await linkedinGetMyPostsTool.execute({});
    expect(mockGet).toHaveBeenCalledWith({ limit: undefined });
  });

  it("handles network error", async () => {
    mockGet.mockResolvedValueOnce({ success: false, error: "ECONNRESET" });
    const res = await linkedinGetMyPostsTool.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("ECONNRESET");
  });
});
