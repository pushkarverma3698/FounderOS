/**
 * Composio LinkedIn provider contract tests.
 * These assert the exact action names + field shapes sent to Composio.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getLinkedInConnectionId: () => "ca_li_test",
    getLinkedInUserId: () => "li_user_test",
    getLinkedInAuthorUrn: () => "urn:li:person:TEST123",
  };
});

const { composioLinkedInPost } = await import("../../../../src/infra/providers/linkedin-composio.js");

describe("composioLinkedInPost contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockExecuteComposioAction.mockResolvedValue({ data: { x_restli_id: "urn:li:share:1" } });
  });

  it("calls LINKEDIN_CREATE_LINKED_IN_POST with commentary not text", async () => {
    await composioLinkedInPost({
      text: "Hello world",
      author_urn: "urn:li:person:TEST123",
      visibility: "PUBLIC",
    });

    const [action, fields] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(action).toBe("LINKEDIN_CREATE_LINKED_IN_POST");
    expect(fields).toHaveProperty("commentary", "Hello world");
    expect(fields).not.toHaveProperty("text");
    expect(fields["visibility"]).toBe("PUBLIC");
    expect(fields["author"]).toBe("urn:li:person:TEST123");
  });

  it("passes scheduled_publish_time when schedule_time is set", async () => {
    await composioLinkedInPost({
      text: "Scheduled post",
      author_urn: "urn:li:person:TEST123",
      visibility: "PUBLIC",
      schedule_time: "2026-07-01T09:00:00Z",
    });

    const [, fields] = mockExecuteComposioAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toHaveProperty("scheduled_publish_time", "2026-07-01T09:00:00Z");
  });
});
