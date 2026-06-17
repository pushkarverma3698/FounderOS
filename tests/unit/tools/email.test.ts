/**
 * Unit tests for emailTool — tool boundary (idempotency + audit).
 * Provider transport is mocked at the dispatch layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderSendEmail = vi.fn();

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerSendEmail: mockProviderSendEmail,
}));

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

describe("emailTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
    mockProviderSendEmail.mockResolvedValue({
      success: true,
      data: { message_id: "msg_abc123", to: "alice@example.com", subject: "Hello" },
    });
  });

  it("returns success and records audit when provider returns a message id", async () => {
    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { message_id: string }).message_id).toBe("msg_abc123");
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    expect(mockProviderSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "alice@example.com", subject: "Hello", body: "Test body" }),
    );
  });

  it("returns success: false when provider soft-fails with no message id", async () => {
    mockProviderSendEmail.mockResolvedValue({
      success: false,
      error: "Authentication failed. Please reconnect your Gmail account.",
    });

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Authentication");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns success: true (skipped) without calling provider when already audited", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await emailTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect((result.data as { skipped: boolean }).skipped).toBe(true);
    expect(mockProviderSendEmail).not.toHaveBeenCalled();
  });

  it("passes optional cc and reply_to to the provider", async () => {
    await emailTool.execute({
      ...BASE_ARGS,
      cc: "bob@example.com",
      reply_to: "noreply@turicks.com",
    });

    expect(mockProviderSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: "bob@example.com",
        reply_to: "noreply@turicks.com",
      }),
    );
  });
});
