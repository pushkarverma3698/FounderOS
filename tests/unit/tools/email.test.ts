/**
 * Unit tests for emailTool (GMAIL_SEND_EMAIL via Composio).
 *
 * Key scenarios:
 *  1. Happy path — Composio returns an id → audit written, success: true
 *  2. Soft failure — Composio returns 200 + error message, NO id →
 *     success: false (NOT recorded as sent, retry is not suppressed)
 *  3. Already sent (idempotency) — audit exists → skipped, success: true
 *  4. Missing API key → success: false early
 *  5. Thrown error → success: false
 *  6. Correct Composio action name + field names
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (declared before dynamic import) ────────────────────────────────────

const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getGmailConnectionId: () => "ca_test_gmail",
    getGmailUserId: () => "user_test",
  };
});

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => undefined);

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

const { emailTool } = await import("../../../src/tools/email.js");

const BASE_ARGS = {
  to: "alice@example.com",
  subject: "Hello",
  body: "Test body",
  idempotency_key: "email:test:abc123",
  tenant_id: "turicks",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emailTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns success and records audit when Composio returns a message id", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: { id: "msg_abc123" },
    });

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { message_id: string }).message_id).toBe("msg_abc123");

    // Audit entry must be written
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: "email:test:abc123" }),
    );
  });

  it("calls Composio with GMAIL_SEND_EMAIL action and correct field names", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "msg_1" } });

    await emailTool.execute(BASE_ARGS);

    expect(mockExecuteComposioAction).toHaveBeenCalledOnce();
    const [action, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(action).toBe("GMAIL_SEND_EMAIL");
    expect(args).toMatchObject({
      recipient_email: "alice@example.com",
      subject: "Hello",
      body: "Test body",
    });
    // Verify it does NOT use 'to' as the field name (a past bug pattern)
    expect(args).not.toHaveProperty("to");
  });

  // ── P0: Soft-failure detection ──────────────────────────────────────────────

  it("returns success: false when Composio returns 200 + error message with no id", async () => {
    // Soft failure: HTTP 200 but the API returns an error message, no message id
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "Authentication failed. Please reconnect your Gmail account." },
    });

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Authentication");
  });

  it("does NOT write audit entry on soft failure (so retry is not suppressed)", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: { message: "Rate limit exceeded" },
    });

    await emailTool.execute(BASE_ARGS);

    // Critical: no audit entry written — the retry must not be blocked
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("does NOT write audit entry when message_id is undefined", async () => {
    // Composio returns a response with no id field at all
    mockExecuteComposioAction.mockResolvedValue({
      data: {},
    });

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("returns success: true (skipped) without calling Composio when already audited", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("returns success: false when COMPOSIO_API_KEY is missing", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
    expect(mockExecuteComposioAction).not.toHaveBeenCalled();
  });

  it("returns success: false when Composio throws a network error", async () => {
    mockExecuteComposioAction.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("passes optional cc and reply_to fields to Composio when provided", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "msg_2" } });

    await emailTool.execute({
      ...BASE_ARGS,
      cc: "bob@example.com",
      reply_to: "noreply@turicks.com",
    });

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["cc"]).toBe("bob@example.com");
    expect(args["reply_to"]).toBe("noreply@turicks.com");
  });

  it("does not include cc or reply_to in Composio args when not provided", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { id: "msg_3" } });

    await emailTool.execute(BASE_ARGS);

    const [, args] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(args).not.toHaveProperty("cc");
    expect(args).not.toHaveProperty("reply_to");
  });
});
