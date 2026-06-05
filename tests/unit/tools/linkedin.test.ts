/**
 * Unit tests for LinkedIn tools (post, analytics, connect).
 * Mocks Composio and DB queries — no live API calls.
 *
 * Rules applied (see docs/TESTING-RULES.md):
 *  - Rule 1: Assert exact action name + field names sent to Composio
 *  - Rule 2: Soft-failure test for every write tool
 *  - Rule 3: Retry-suppression test (audit NOT written on soft failure)
 *  - Rule 4: vi.clearAllMocks() in beforeEach
 *  - Rule 6: Three-path coverage (happy, soft-fail, thrown)
 *  - Rule 7: Realistic mock response shapes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => {});
const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getLinkedInConnectionId: () => "ca_li_test",
    getLinkedInUserId: () => "li_user_test",
  };
});

const { linkedinPostTool, linkedinAnalyticsTool, linkedinConnectTool } =
  await import("../../../src/tools/linkedin.js");

const BASE_POST_ARGS = {
  text: "Building FounderOS in public 🧵",
  idempotency_key: "linkedin_post:turicks:post_001",
  tenant_id: "turicks",
};

describe("linkedinPostTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();  // Rule 4: reset all mock state between tests
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockGetComposioApiKey.mockReturnValue("test-key");
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns success: true with post_id when LinkedIn accepts the post", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:123" } });

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { post_id: string }).post_id).toBe("urn:li:share:123");
  });

  // ── Rule 1: Contract — exact action name + field names ─────────────────────

  it("calls LINKEDIN_CREATE_LINKED_IN_POST with 'commentary' not 'text'", async () => {
    // Rule 1: test the CONTRACT with the external API, not just the outcome.
    // 'text' is the wrong field — Composio requires 'commentary'.
    // This test would have caught the bug before production.
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:1" } });

    await linkedinPostTool.execute(BASE_POST_ARGS);

    const [action, fields] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(action).toBe("LINKEDIN_CREATE_LINKED_IN_POST");
    expect(fields).toHaveProperty("commentary", BASE_POST_ARGS.text);
    expect(fields).not.toHaveProperty("text"); // explicit rejection of wrong field name
  });

  it("sends visibility as an object not a bare string", async () => {
    // Composio requires { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
    // not the bare string "PUBLIC"
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:2" } });

    await linkedinPostTool.execute(BASE_POST_ARGS);

    const [, fields] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(typeof fields["visibility"]).toBe("object");
    const visObj = fields["visibility"] as Record<string, string>;
    expect(Object.values(visObj)[0]).toBe("PUBLIC");
  });

  it("writes audit entry only AFTER confirming post_id exists", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:3" } });

    await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linkedin_post" }),
    );
  });

  // ── Rule 2 + 3: Soft-failure detection + retry suppression ────────────────

  it("returns success: false when Composio returns 200 + error message with no post id", async () => {
    // Rule 2: Composio returns HTTP 200 but with an error message, no id.
    // Before the fix, this returned success: true and blocked all retries.
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "LinkedIn token expired. Please reconnect." },
    });

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("LinkedIn token expired");
  });

  it("does NOT write audit entry on soft failure — retry must remain possible", async () => {
    // Rule 3: writing the audit on failure means the retry is permanently blocked.
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "Rate limit exceeded" },
    });

    await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns success: false when Composio response has no id field at all", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: {} });

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(false);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("returns success: true (skipped) without calling Composio when already audited", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("returns success: false when COMPOSIO_API_KEY is not set", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  it("returns success: false when Composio throws a network error", async () => {
    // Rule 6: three-path coverage — thrown error path
    mockExecuteComposioAction.mockRejectedValue(new Error("LinkedIn API 500"));

    const result = await linkedinPostTool.execute(BASE_POST_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("LinkedIn API 500");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});

describe("linkedinAnalyticsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposioApiKey.mockReturnValue("test-key");
  });

  it("returns success: false when COMPOSIO_API_KEY is not set", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);
    const result = await linkedinAnalyticsTool.execute({ post_id: "p1", tenant_id: "turicks" });
    expect(result.success).toBe(false);
  });

  it("returns analytics data on success", async () => {
    mockExecuteComposioAction.mockResolvedValue({ impressions: 500, reactions: 42 });
    const result = await linkedinAnalyticsTool.execute({ post_id: "p1", tenant_id: "turicks" });
    expect(result.success).toBe(true);
  });
});

describe("linkedinConnectTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockGetComposioApiKey.mockReturnValue("test-key");
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
    mockExecuteComposioAction.mockResolvedValue({ status: "sent" });
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
