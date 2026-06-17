/**
 * Unit tests for the readEmails tool — provider dispatch layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderReadEmails = vi.fn();
const mockGetGmailBackend = vi.fn(() => "gws" as const);

vi.mock("../../../src/infra/providers/index.js", () => ({
  providerReadEmails: mockProviderReadEmails,
}));

vi.mock("../../../src/infra/provider-config.js", () => ({
  getGmailBackend: mockGetGmailBackend,
}));

const { readEmailsTool } = await import("../../../src/tools/email-reader.js");

describe("readEmailsTool provider dispatch", () => {
  beforeEach(() => {
    mockProviderReadEmails.mockReset();
    mockGetGmailBackend.mockReturnValue("gws");
    mockProviderReadEmails.mockResolvedValue({ success: true, data: "inbox data" });
  });

  it("delegates to providerReadEmails", async () => {
    const result = await readEmailsTool.execute({ query: "is:unread", max_results: 5 });

    expect(mockProviderReadEmails).toHaveBeenCalledWith({ query: "is:unread", max_results: 5 });
    expect(result.data).toBe("inbox data");
  });

  it("defaults query and max_results", async () => {
    await readEmailsTool.execute({});

    expect(mockProviderReadEmails).toHaveBeenCalledWith({ query: "in:inbox", max_results: 10 });
  });
});
