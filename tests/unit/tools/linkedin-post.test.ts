/**
 * Unit tests for linkedinPostTool — focused on L5: schedule_time passthrough.
 *
 * Key scenarios:
 *  1. schedule_time provided → scheduled_publish_time field is in Composio args
 *  2. schedule_time absent → scheduled_publish_time NOT in Composio args
 *  3. Happy path — Composio returns a post id → audit written, success: true
 *  4. Soft failure — Composio returns 200 + error message, NO id →
 *     success: false, audit NOT written (retry not suppressed)
 *  5. Idempotency — already audited → skipped, success: true
 *  6. Missing API key → success: false early
 *  7. Thrown error → success: false
 *  8. Correct action name + field names (commentary not text, visibility object)
 *  9. schedule_time failure → error hints at scheduling not supported
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getLinkedInConnectionId: () => "ca_test_li",
    getLinkedInUserId: () => "turicks-internal",
    getLinkedInAuthorUrn: () => "urn:li:person:TEST123",
  };
});

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("linkedinPostTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns success and records audit when Composio returns a post id", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: { id: "urn:li:share:7234567890" },
    });

    const result = await linkedinPostTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { post_id: string }).post_id).toBe("urn:li:share:7234567890");
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
  });

  it("calls Composio with LINKEDIN_CREATE_LINKED_IN_POST and correct field names", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:1" } });

    await linkedinPostTool.execute(BASE_ARGS);

    const [action, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(action).toBe("LINKEDIN_CREATE_LINKED_IN_POST");
    // Composio wants 'commentary', not 'text'
    expect(args).toHaveProperty("commentary", BASE_ARGS.text);
    expect(args).not.toHaveProperty("text");
    // 'author' member URN is REQUIRED (live contract — Composio 400s without it)
    expect(args).toHaveProperty("author", "urn:li:person:TEST123");
    // visibility must be a PLAIN STRING enum, not an object (Composio rejects objects)
    expect(typeof args["visibility"]).toBe("string");
  });

  it("sets PUBLIC visibility (plain string) by default", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:2" } });

    await linkedinPostTool.execute(BASE_ARGS);

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["visibility"]).toBe("PUBLIC");
  });

  it("sets CONNECTIONS visibility (plain string) when requested", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:3" } });

    await linkedinPostTool.execute({ ...BASE_ARGS, visibility: "CONNECTIONS" });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["visibility"]).toBe("CONNECTIONS");
  });

  // ── P0: Soft-failure detection ──────────────────────────────────────────────

  it("returns success: false when Composio returns 200 + error message with no post id", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "LinkedIn token expired. Please reconnect." },
    });

    const result = await linkedinPostTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("LinkedIn token expired");
  });

  it("does NOT write audit entry on soft failure (so retry is not suppressed)", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "Rate limit exceeded" },
    });

    await linkedinPostTool.execute(BASE_ARGS);

    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("does NOT write audit entry when post id is undefined in response", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: {} });

    const result = await linkedinPostTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("returns success: true (skipped) without calling Composio when already audited", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await linkedinPostTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("returns success: false when COMPOSIO_API_KEY is missing", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);

    const result = await linkedinPostTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  it("returns success: false when Composio throws a network error", async () => {
    mockExecuteComposioAction.mockRejectedValue(new Error("timeout"));

    const result = await linkedinPostTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  // ── L5: schedule_time passthrough ──────────────────────────────────────────

  it("passes scheduled_publish_time to Composio args when schedule_time is provided", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:scheduled1" } });

    await linkedinPostTool.execute({
      ...BASE_ARGS,
      idempotency_key: "linkedin_post:turicks:scheduled_001",
      schedule_time: "2026-07-01T09:00:00Z",
    });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toHaveProperty("scheduled_publish_time", "2026-07-01T09:00:00Z");
  });

  it("does NOT include scheduled_publish_time in Composio args when schedule_time is absent", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "urn:li:share:immediate1" } });

    await linkedinPostTool.execute({
      ...BASE_ARGS,
      idempotency_key: "linkedin_post:turicks:immediate_001",
    });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args).not.toHaveProperty("scheduled_publish_time");
  });
});
