/**
 * Unit tests for inbox fast path and execution guard inbox claims.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();

vi.mock("../../../src/tools/email-reader.js", () => ({
  readEmailsTool: { execute: mockExecute },
}));

const { isInboxReadOnlyRequest, detectUnbackedInboxClaim } = await import(
  "../../../src/gateway/execution-guard.js"
);
const { tryInboxReadFastPath, inboxQueryForRequest } = await import(
  "../../../src/gateway/inbox-fast-path.js"
);

describe("isInboxReadOnlyRequest", () => {
  it("matches simple unread inbox checks", () => {
    expect(isInboxReadOnlyRequest("Check my unread emails.")).toBe(true);
    expect(isInboxReadOnlyRequest("inbox check pls")).toBe(true);
  });

  it("excludes draft/reply workflows", () => {
    expect(isInboxReadOnlyRequest("Check my emails and draft a reply to the urgent one")).toBe(
      false,
    );
  });
});

describe("inboxQueryForRequest", () => {
  it("uses is:unread when unread is mentioned", () => {
    expect(inboxQueryForRequest("Check my unread emails")).toBe("is:unread");
  });

  it("defaults to in:inbox otherwise", () => {
    expect(inboxQueryForRequest("Check my emails")).toBe("in:inbox");
  });
});

describe("tryInboxReadFastPath", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("calls read_emails for inbox-only requests", async () => {
    mockExecute.mockResolvedValue({
      success: true,
      data: "1. From: alice@example.com\n   Subject: Hello",
    });
    const out = await tryInboxReadFastPath("Check my unread emails.");
    expect(mockExecute).toHaveBeenCalledWith({ query: "is:unread", max_results: 10 });
    expect(out).toContain("alice@example.com");
    expect(out).toContain("Hello");
  });

  it("returns null for non-inbox requests", async () => {
    expect(await tryInboxReadFastPath("List my GitHub repos")).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("detectUnbackedInboxClaim", () => {
  it("flags vague inbox summaries without read_emails", () => {
    const reply = "You have several unread emails that need your attention.";
    expect(
      detectUnbackedInboxClaim("Check my unread emails.", [{ content: reply, _getType: () => "ai" }], reply),
    ).toBe(true);
  });

  it("passes when read_emails was called", () => {
    const msgs = [
      { content: "", _getType: () => "ai", tool_calls: [{ name: "read_emails" }] },
      { name: "read_emails", content: "From: x", _getType: () => "tool" },
    ];
    expect(
      detectUnbackedInboxClaim("Check my unread emails.", msgs, "From: x — Subject: y"),
    ).toBe(false);
  });
});
