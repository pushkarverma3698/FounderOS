/**
 * Unit tests for the readEmails tool — dual backend dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockComposioRead = vi.fn();
const mockGwsRead = vi.fn();
const mockGetGmailBackend = vi.fn(() => "composio" as const);

vi.mock("../../../src/tools/gmail-composio-read.js", () => ({
  readEmailsViaComposio: mockComposioRead,
}));

vi.mock("../../../src/tools/gmail-gws-read.js", () => ({
  readEmailsViaGws: mockGwsRead,
}));

vi.mock("../../../src/infra/provider-config.js", () => ({
  getGmailBackend: mockGetGmailBackend,
}));

const { readEmailsTool } = await import("../../../src/tools/email-reader.js");

describe("readEmailsTool dual backend", () => {
  beforeEach(() => {
    mockComposioRead.mockReset();
    mockGwsRead.mockReset();
    mockGetGmailBackend.mockReturnValue("composio");
    mockComposioRead.mockResolvedValue({ success: true, data: "composio inbox" });
    mockGwsRead.mockResolvedValue({ success: true, data: "gws inbox" });
  });

  it("uses composio backend by default", async () => {
    const result = await readEmailsTool.execute({ query: "is:unread" });
    expect(mockComposioRead).toHaveBeenCalled();
    expect(mockGwsRead).not.toHaveBeenCalled();
    expect(result.data).toBe("composio inbox");
  });

  it("uses gws when GMAIL_BACKEND=gws", async () => {
    mockGetGmailBackend.mockReturnValue("gws");
    const result = await readEmailsTool.execute({ query: "is:unread" });
    expect(mockGwsRead).toHaveBeenCalled();
    expect(mockComposioRead).not.toHaveBeenCalled();
    expect(result.data).toBe("gws inbox");
  });
});
