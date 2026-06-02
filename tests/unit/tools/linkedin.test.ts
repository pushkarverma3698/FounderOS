/**
 * Unit tests for the LinkedIn tools (post, analytics, connect).
 * Mocks Composio and DB queries — no live API calls.
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

describe("linkedinPostTool", () => {
  beforeEach(() => {
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockExecuteComposioAction.mockReset();
  });

  it("returns error when COMPOSIO_API_KEY is not set", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);
    const result = await linkedinPostTool.execute({
      text: "Test post",
      idempotency_key: "k1",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
  });

  it("returns skipped when idempotency key already used", async () => {
    mockHasBeenAudited.mockResolvedValue(true);
    const result = await linkedinPostTool.execute({
      text: "Test post",
      idempotency_key: "already-sent",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).skipped).toBe(true);
  });

  it("publishes a post and writes audit entry on success", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "post_123" } });
    const result = await linkedinPostTool.execute({
      text: "Hello LinkedIn",
      idempotency_key: "k-new",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(true);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linkedin_post" }),
    );
  });

  it("returns error on Composio failure", async () => {
    mockExecuteComposioAction.mockRejectedValue(new Error("LinkedIn API 500"));
    const result = await linkedinPostTool.execute({
      text: "Boom",
      idempotency_key: "k-fail",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("LinkedIn API 500");
  });
});

describe("linkedinAnalyticsTool", () => {
  beforeEach(() => {
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockExecuteComposioAction.mockReset();
  });

  it("returns error when COMPOSIO_API_KEY is not set", async () => {
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
    mockHasBeenAudited.mockResolvedValue(false);
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockExecuteComposioAction.mockReset();
  });

  it("skips when connection request already sent", async () => {
    mockHasBeenAudited.mockResolvedValue(true);
    const result = await linkedinConnectTool.execute({
      profile_urn: "urn:li:person:ABC123",
      tenant_id: "turicks",
    });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).skipped).toBe(true);
  });

  it("sends connection request and writes audit entry", async () => {
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
