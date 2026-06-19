/**
 * Unit tests for LinkedIn tools — tool boundary (idempotency + audit).
 * Provider contract tests live in tests/unit/infra/providers/.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => ({ written: true }));
const mockProviderLinkedInPost = vi.fn();
const mockProviderLinkedInAnalytics = vi.fn();
const mockProviderLinkedInConnect = vi.fn();
const mockGetLinkedInAuthorUrn = vi.fn(() => "urn:li:person:TEST123");
const mockGetLinkedInBackend = vi.fn(() => "direct" as const);

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerLinkedInPost: mockProviderLinkedInPost,
  providerLinkedInAnalytics: mockProviderLinkedInAnalytics,
  providerLinkedInConnect: mockProviderLinkedInConnect,
  getLinkedInAuthorUrn: mockGetLinkedInAuthorUrn,
}));

vi.mock("../../../src/infra/provider-config.js", () => ({
  getLinkedInBackend: mockGetLinkedInBackend,
}));

const { linkedinPostTool, linkedinAnalyticsTool, linkedinConnectTool } =
  await import("../../../src/tools/linkedin.js");

const BASE_POST_ARGS = {
  text: "Building FounderOS in public 🧵",
  idempotency_key: "linkedin_post:turicks:post_001",
  tenant_id: "turicks",
};

describe("linkedinPostTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue({ written: true });
    mockGetLinkedInAuthorUrn.mockReturnValue("urn:li:person:TEST123");
    mockGetLinkedInBackend.mockReturnValue("direct");
    mockProviderLinkedInPost.mockResolvedValue({
      success: true,
      data: { post_id: "urn:li:share:123", post_url: "https://www.linkedin.com/feed/update/urn:li:share:123" },
    });
  });

  it("returns success: true with post_id when provider accepts the post", async () => {
    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { post_id: string }).post_id).toBe("urn:li:share:123");
  });

  it("passes author URN and visibility to the provider", async () => {
    await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(mockProviderLinkedInPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: BASE_POST_ARGS.text,
        author_urn: "urn:li:person:TEST123",
        visibility: "PUBLIC",
      }),
    );
  });

  it("writes audit entry only AFTER confirming post_id exists", async () => {
    await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linkedin_post" }),
    );
  });

  it("returns success: false on provider soft failure", async () => {
    mockProviderLinkedInPost.mockResolvedValue({
      success: false,
      error: "LinkedIn token expired. Please reconnect.",
    });

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(false);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns success: true (skipped) without calling provider when already audited", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    expect(mockProviderLinkedInPost).not.toHaveBeenCalled();
  });

  it("returns success: false when direct backend has no author URN", async () => {
    mockGetLinkedInAuthorUrn.mockReturnValue(undefined);

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("LINKEDIN_AUTHOR_URN");
    expect(mockProviderLinkedInPost).not.toHaveBeenCalled();
  });
});

describe("linkedinAnalyticsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderLinkedInAnalytics.mockResolvedValue({ success: true, data: { impressions: 500 } });
  });

  it("delegates to providerLinkedInAnalytics", async () => {
    const result = await linkedinAnalyticsTool.execute({ post_id: "p1", tenant_id: "turicks" });
    expect(result.success).toBe(true);
    expect(mockProviderLinkedInAnalytics).toHaveBeenCalledWith("p1");
  });
});

describe("linkedinConnectTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockProviderLinkedInConnect.mockResolvedValue({ success: true, data: { status: "sent" } });
  });

  it("returns success: true (skipped) when connection request already sent", async () => {
    mockHasBeenAudited.mockResolvedValue(true);
    const result = await linkedinConnectTool.execute({
      profile_urn: "urn:li:person:ABC123",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).skipped).toBe(true);
  });

  it("sends connection request and writes audit entry on success", async () => {
    const result = await linkedinConnectTool.execute({
      profile_urn: "urn:li:person:XYZ",
      message: "Hi from Turicks",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(true);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linkedin_connect" }),
    );
  });
});
