/**
 * Unit tests for linkedinPostTool — schedule_time passthrough via provider dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderLinkedInPost = vi.fn();
const mockGetLinkedInAuthorUrn = vi.fn(() => "urn:li:person:TEST123");
const mockGetLinkedInBackend = vi.fn(() => "direct" as const);

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerLinkedInPost: mockProviderLinkedInPost,
  getLinkedInAuthorUrn: mockGetLinkedInAuthorUrn,
}));

vi.mock("../../../src/infra/provider-config.js", () => ({
  getLinkedInBackend: mockGetLinkedInBackend,
}));

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => undefined);

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

const { linkedinPostTool } = await import("../../../src/tools/linkedin.js");

const BASE_ARGS = {
  text: "Building FounderOS in public. Thread 🧵",
  idempotency_key: "linkedin_post:turicks:post_001",
  tenant_id: "turicks",
};

describe("linkedinPostTool schedule_time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockGetLinkedInAuthorUrn.mockReturnValue("urn:li:person:TEST123");
    mockProviderLinkedInPost.mockResolvedValue({
      success: true,
      data: { post_id: "urn:li:share:1", post_url: "https://linkedin.com/feed/update/1" },
    });
  });

  it("passes schedule_time to the provider when provided", async () => {
    await linkedinPostTool.execute({
      ...BASE_ARGS,
      schedule_time: "2026-07-01T09:00:00Z",
    });

    expect(mockProviderLinkedInPost).toHaveBeenCalledWith(
      expect.objectContaining({ schedule_time: "2026-07-01T09:00:00Z" }),
    );
  });

  it("does not pass schedule_time when absent", async () => {
    await linkedinPostTool.execute(BASE_ARGS);

    expect(mockProviderLinkedInPost).toHaveBeenCalledWith(
      expect.objectContaining({ schedule_time: undefined }),
    );
  });
});
