/**
 * Unit tests for the readEmails tool.
 * Mocks Composio so no live API keys are needed.
 *
 * RED: these tests fail until src/tools/email-reader.ts is implemented.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Composio before importing the tool
const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getGmailConnectionId: () => "ca_test",
    getGmailUserId: () => "user_test",
  };
});

const { readEmailsTool } = await import("../../../src/tools/email-reader.js");

describe("readEmailsTool", () => {
  beforeEach(() => {
    mockExecuteComposioAction.mockReset();
    mockGetComposioApiKey.mockReturnValue("test-key");
  });

  it("returns an error when COMPOSIO_API_KEY is not configured", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);
    const result = await readEmailsTool.execute({ query: "from:test@example.com" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPOSIO_API_KEY");
  });

  it("returns formatted email list on success", async () => {
    mockExecuteComposioAction.mockResolvedValue({
      data: {
        messages: [
          {
            id: "msg1",
            from: "alice@example.com",
            subject: "Hello there",
            snippet: "Just checking in...",
            date: "2026-06-01",
          },
        ],
      },
    });

    const result = await readEmailsTool.execute({ query: "is:unread" });
    expect(result.success).toBe(true);
    const text = result.data as string;
    expect(text).toContain("alice@example.com");
    expect(text).toContain("Hello there");
  });

  it("returns empty-state message when no emails found", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { messages: [] } });
    const result = await readEmailsTool.execute({ query: "is:unread" });
    expect(result.success).toBe(true);
    expect(result.data).toContain("No emails found");
  });

  it("returns error on Composio failure", async () => {
    mockExecuteComposioAction.mockRejectedValue(new Error("API timeout"));
    const result = await readEmailsTool.execute({ query: "is:unread" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("API timeout");
  });

  it("defaults to inbox query when no query provided", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { messages: [] } });
    await readEmailsTool.execute({});
    expect(mockExecuteComposioAction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: expect.any(String) }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("respects a maxResults limit", async () => {
    mockExecuteComposioAction.mockResolvedValue({ data: { messages: [] } });
    await readEmailsTool.execute({ query: "is:unread", max_results: 3 });
    expect(mockExecuteComposioAction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max_results: 3 }),
      expect.any(String),
      expect.any(String),
    );
  });
});
