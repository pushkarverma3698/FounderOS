/**
 * Unit tests for the /status command helper: formatStatusMessage().
 * Tests the pure formatting logic — no DB/Redis calls.
 *
 * RED: fails until src/gateway/status.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import { formatStatusMessage } from "../../../src/gateway/status.js";

describe("formatStatusMessage", () => {
  it("includes uptime in the message", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 3661, pendingApprovals: 0, emailsSentToday: 0 });
    expect(msg).toContain("1h 1m");
  });

  it("formats uptime under 60 seconds as seconds", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 45, pendingApprovals: 0, emailsSentToday: 0 });
    expect(msg).toContain("45s");
  });

  it("formats uptime under 60 minutes without hours", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 600, pendingApprovals: 0, emailsSentToday: 0 });
    expect(msg).toContain("10m");
    expect(msg).not.toMatch(/\dh/);
  });

  it("shows pending approvals count", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 100, pendingApprovals: 3, emailsSentToday: 0 });
    expect(msg).toContain("3");
    expect(msg).toMatch(/pending/i);
  });

  it("shows zero pending approvals as all clear", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 100, pendingApprovals: 0, emailsSentToday: 0 });
    expect(msg).toMatch(/0|none|clear/i);
  });

  it("shows emails sent today", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 100, pendingApprovals: 0, emailsSentToday: 5 });
    expect(msg).toContain("5");
    expect(msg).toMatch(/email/i);
  });

  it("returns HTML-safe content (no raw angle brackets)", () => {
    const msg = formatStatusMessage({ uptimeSeconds: 100, pendingApprovals: 0, emailsSentToday: 0 });
    // Should not have unescaped < or > that would break Telegram HTML parse mode
    // (pre/code tags are allowed but should be balanced)
    const stripped = msg.replace(/<[^>]+>/g, "");
    expect(stripped).not.toMatch(/[<>]/);
  });
});
