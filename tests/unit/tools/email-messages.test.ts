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

describe("emailFromGwsGet — full-format body extraction", () => {
  const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  it("decodes a top-level body (simple non-multipart message)", () => {
    const msg = emailFromGwsGet({
      id: "m1",
      snippet: "snippet only",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "a@b.com" }],
        body: { data: b64url("Full body text of the email."), size: 28 },
      },
    });
    expect(msg.messageText).toBe("Full body text of the email.");
  });

  it("prefers the text/plain part in a multipart message", () => {
    const msg = emailFromGwsGet({
      id: "m2",
      snippet: "snip",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
          { mimeType: "text/plain", body: { data: b64url("plain body wins") } },
        ],
      },
    });
    expect(msg.messageText).toBe("plain body wins");
  });

  it("recurses into nested multipart containers", () => {
    const msg = emailFromGwsGet({
      id: "m3",
      snippet: "snip",
      payload: {
        mimeType: "multipart/mixed",
        headers: [],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain", body: { data: b64url("nested plain") } }],
          },
          { mimeType: "application/pdf", body: { attachmentId: "att1" } },
        ],
      },
    });
    expect(msg.messageText).toBe("nested plain");
  });

  it("strips tags from an html-only message", () => {
    const msg = emailFromGwsGet({
      id: "m4",
      snippet: "snip",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [{ mimeType: "text/html", body: { data: b64url("<div>Make your <b>journey</b> smoother</div>") } }],
      },
    });
    expect(msg.messageText).toContain("Make your journey smoother");
    expect(msg.messageText).not.toContain("<div>");
  });

  it("falls back to snippet when no decodable body exists (metadata-format payload)", () => {
    const msg = emailFromGwsGet({
      id: "m5",
      snippet: "Hello world",
      payload: { headers: [{ name: "From", value: "a@b.com" }] },
    });
    expect(msg.messageText).toBe("Hello world");
  });
});

describe("formatEmailList — body budget", () => {
  it("includes bodies well beyond the old 200-char snippet cap", () => {
    const body = "x".repeat(1500) + "END_MARKER";
    const out = formatEmailList([{ sender: "a@b.com", subject: "s", messageText: body }], "q", 5);
    expect(out).toContain("END_MARKER");
  });

  it("still caps runaway bodies to protect model context", () => {
    const body = "y".repeat(10_000);
    const out = formatEmailList([{ sender: "a@b.com", subject: "s", messageText: body }], "q", 5);
    expect(out.length).toBeLessThan(5_000);
  });
});
