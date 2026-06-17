/**
 * Unit tests — shared email message parsing + formatting
 */

import { describe, it, expect } from "vitest";
import {
  extractComposioMessages,
  extractGwsMessageIds,
  emailFromGwsGet,
  formatEmailList,
} from "../../../src/tools/email-messages.js";

describe("extractComposioMessages", () => {
  it("reads nested data.messages shape", () => {
    const msgs = extractComposioMessages({
      data: { messages: [{ sender: "a@b.com", subject: "Hi" }] },
    });
    expect(msgs[0]?.sender).toBe("a@b.com");
  });
});

describe("extractGwsMessageIds", () => {
  it("extracts ids from Gmail API list response", () => {
    const ids = extractGwsMessageIds({ messages: [{ id: "abc123" }, { id: "def456" }] });
    expect(ids).toEqual(["abc123", "def456"]);
  });

  it("handles data wrapper", () => {
    const ids = extractGwsMessageIds({ data: { messages: [{ id: "x1" }] } });
    expect(ids).toEqual(["x1"]);
  });
});

describe("emailFromGwsGet", () => {
  it("maps metadata headers and snippet", () => {
    const msg = emailFromGwsGet({
      id: "m1",
      snippet: "Hello world",
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "Subject", value: "Test" },
          { name: "Date", value: "Mon, 1 Jun 2026" },
        ],
      },
    });
    expect(msg.sender).toBe("alice@example.com");
    expect(msg.subject).toBe("Test");
    expect(msg.messageText).toBe("Hello world");
  });
});

describe("formatEmailList", () => {
  it("returns empty-state copy", () => {
    expect(formatEmailList([], "is:unread", 10)).toContain("No emails found");
  });
});
