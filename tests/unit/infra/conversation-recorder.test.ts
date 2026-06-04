/**
 * TDD — conversation-recorder unit tests
 *
 * Tests the recordConversationEnd() function that writes a summary +
 * topic-tags to the `conversations` table after each Telegram run.
 *
 * All DB I/O is mocked — no live Postgres needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB query mocks ────────────────────────────────────────────────────────────

const mockUpsertConversation = vi.fn(async () => {});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    upsertConversation: mockUpsertConversation,
  };
});

const { recordConversationEnd } = await import("../../../src/infra/conversation-recorder.js");

// ── Test messages fixture ─────────────────────────────────────────────────────

function makeMessages(texts: string[]) {
  return texts.map((content) => ({
    content,
    _getType: () => "ai",
    tool_calls: [],
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recordConversationEnd", () => {
  beforeEach(() => {
    mockUpsertConversation.mockClear();
  });

  it("calls upsertConversation with the thread_id", async () => {
    const msgs = makeMessages(["We discussed Stripe webhooks. The plan is to build a TypeScript handler."]);
    await recordConversationEnd("turicks:12345", msgs);

    expect(mockUpsertConversation).toHaveBeenCalledOnce();
    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg["thread_id"]).toBe("turicks:12345");
  });

  it("extracts a non-empty summary from the last AI message", async () => {
    const msgs = makeMessages([
      "First message about research.",
      "Then we discussed the Stripe webhook integration with TypeScript.",
    ]);
    await recordConversationEnd("turicks:abc", msgs);

    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof arg["summary"]).toBe("string");
    expect((arg["summary"] as string).length).toBeGreaterThan(5);
  });

  it("caps summary at 500 characters", async () => {
    const longText = "x".repeat(2000);
    const msgs = makeMessages([longText]);
    await recordConversationEnd("turicks:long", msgs);

    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((arg["summary"] as string).length).toBeLessThanOrEqual(500);
  });

  it("extracts topics as a non-empty array of strings", async () => {
    const msgs = makeMessages(["We talked about LinkedIn marketing and Stripe payments."]);
    await recordConversationEnd("turicks:topics", msgs);

    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Array.isArray(arg["topics"])).toBe(true);
    expect((arg["topics"] as string[]).length).toBeGreaterThan(0);
    expect((arg["topics"] as string[]).every((t) => typeof t === "string")).toBe(true);
  });

  it("passes message_count equal to the number of messages provided", async () => {
    const msgs = makeMessages(["msg1", "msg2", "msg3"]);
    await recordConversationEnd("turicks:count", msgs);

    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg["message_count"]).toBe(3);
  });

  it("sets last_message_at to a recent Date", async () => {
    const before = new Date();
    const msgs = makeMessages(["Some content"]);
    await recordConversationEnd("turicks:time", msgs);
    const after = new Date();

    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    const ts = arg["last_message_at"] as Date;
    expect(ts instanceof Date).toBe(true);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("does NOT throw when messages array is empty — gracefully no-ops", async () => {
    await expect(recordConversationEnd("turicks:empty", [])).resolves.not.toThrow();
  });

  it("skips upsert when messages array is empty", async () => {
    await recordConversationEnd("turicks:empty2", []);
    expect(mockUpsertConversation).not.toHaveBeenCalled();
  });

  it("includes tenant_id in the upserted record", async () => {
    const msgs = makeMessages(["hello world"]);
    await recordConversationEnd("turicks:tenant-check", msgs);
    const arg = mockUpsertConversation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof arg["tenant_id"]).toBe("string");
    expect((arg["tenant_id"] as string).length).toBeGreaterThan(0);
  });
});
