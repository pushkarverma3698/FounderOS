/**
 * Unit tests for the scheduler's scheduled-post sweep — provider + DB mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetDue = vi.fn();
const mockMarkPosted = vi.fn(async () => {});
const mockMarkFailed = vi.fn(async () => {});
const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAudit = vi.fn(async () => ({ written: true }));

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getDueScheduledPosts: mockGetDue,
    markScheduledPostPosted: mockMarkPosted,
    markScheduledPostFailed: mockMarkFailed,
    hasBeenAudited: mockHasBeenAudited,
    writeAuditEntry: mockWriteAudit,
  };
});

const mockProviderPost = vi.fn();
vi.mock("../../../src/infra/providers/index.js", () => ({
  providerLinkedInPost: mockProviderPost,
}));

const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: mockSendToChat }));

const { runScheduledPostSweep } = await import("../../../src/infra/scheduler.js");

function duePost(overrides: Record<string, unknown> = {}) {
  return {
    id: "sp1",
    tenant_id: "turicks",
    platform: "linkedin",
    account_key: "turicks",
    text: "Shipped v3 today",
    mention_urn: "urn:li:organization:99",
    mention_name: "Turicks",
    visibility: "PUBLIC",
    scheduled_at: new Date(),
    status: "scheduled",
    idempotency_key: "linkedin_sched:turicks:abc",
    post_id: null,
    post_url: null,
    error: null,
    created_at: new Date(),
    posted_at: null,
    ...overrides,
  };
}

describe("runScheduledPostSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockProviderPost.mockResolvedValue({
      success: true,
      data: { post_id: "urn:li:share:1", post_url: "https://linkedin.com/feed/1" },
    });
  });

  it("publishes a due post with its mention, audits, and marks it posted", async () => {
    mockGetDue.mockResolvedValue([duePost()]);
    await runScheduledPostSweep();

    expect(mockProviderPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Shipped v3 today",
        mention: { urn: "urn:li:organization:99", name: "Turicks" },
        account_key: "turicks",
        visibility: "PUBLIC",
      }),
    );
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linkedin_post", idempotency_key: "linkedin_sched:turicks:abc" }),
    );
    expect(mockMarkPosted).toHaveBeenCalledWith("sp1", "urn:li:share:1", "https://linkedin.com/feed/1");
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("marks failed + alerts the founder when the provider errors", async () => {
    mockGetDue.mockResolvedValue([duePost()]);
    mockProviderPost.mockResolvedValue({ success: false, error: "429 rate limited" });
    await runScheduledPostSweep();

    expect(mockMarkFailed).toHaveBeenCalledWith("sp1", "429 rate limited");
    expect(mockMarkPosted).not.toHaveBeenCalled();
    expect(mockSendToChat).toHaveBeenCalled();
  });

  it("is idempotent — skips the provider when the key was already audited", async () => {
    mockGetDue.mockResolvedValue([duePost({ post_id: "urn:li:share:existing" })]);
    mockHasBeenAudited.mockResolvedValue(true);
    await runScheduledPostSweep();

    expect(mockProviderPost).not.toHaveBeenCalled();
    expect(mockMarkPosted).toHaveBeenCalledWith("sp1", "urn:li:share:existing");
  });

  it("posts without a mention when none is set on the row", async () => {
    mockGetDue.mockResolvedValue([duePost({ mention_urn: null, mention_name: null })]);
    await runScheduledPostSweep();
    expect(mockProviderPost).toHaveBeenCalledWith(expect.objectContaining({ mention: undefined }));
  });
});
