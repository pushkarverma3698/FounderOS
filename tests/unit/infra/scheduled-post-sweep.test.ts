/**
 * Unit tests for the scheduler's scheduled-post sweep — provider + DB mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClaimDue = vi.fn();
const mockMarkPosted = vi.fn(async () => {});
const mockMarkFailed = vi.fn(async () => {});
const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAudit = vi.fn(async () => ({ written: true }));

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    claimDueScheduledPosts: mockClaimDue,
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
    mockClaimDue.mockResolvedValue([duePost()]);
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
    mockClaimDue.mockResolvedValue([duePost()]);
    mockProviderPost.mockResolvedValue({ success: false, error: "429 rate limited" });
    await runScheduledPostSweep();

    expect(mockMarkFailed).toHaveBeenCalledWith("sp1", "429 rate limited");
    expect(mockMarkPosted).not.toHaveBeenCalled();
    expect(mockSendToChat).toHaveBeenCalled();
  });

  it("is idempotent — skips the provider when the key was already audited", async () => {
    mockClaimDue.mockResolvedValue([duePost({ post_id: "urn:li:share:existing" })]);
    mockHasBeenAudited.mockResolvedValue(true);
    await runScheduledPostSweep();

    expect(mockProviderPost).not.toHaveBeenCalled();
    expect(mockMarkPosted).toHaveBeenCalledWith("sp1", "urn:li:share:existing");
  });

  it("posts without a mention when none is set on the row", async () => {
    mockClaimDue.mockResolvedValue([duePost({ mention_urn: null, mention_name: null })]);
    await runScheduledPostSweep();
    expect(mockProviderPost).toHaveBeenCalledWith(expect.objectContaining({ mention: undefined }));
  });

  it("claims via the ATOMIC claim (not a plain read) so overlapping ticks can't double-post", async () => {
    // The sweep must go through claimDueScheduledPosts, which flips rows to
    // 'posting' in one statement — a second concurrent tick then sees nothing.
    mockClaimDue.mockResolvedValue([]);
    await runScheduledPostSweep();
    expect(mockClaimDue).toHaveBeenCalledTimes(1);
    expect(mockProviderPost).not.toHaveBeenCalled(); // nothing claimed ⇒ nothing posted
  });
});
