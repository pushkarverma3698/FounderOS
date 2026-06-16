/**
 * Unit tests — provider probes (mocked Composio + gws)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunGws = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "ck_test");
const mockGetGmailConnectionId = vi.fn(() => "ca_test");

vi.mock("../../../src/infra/gws-runner.js", () => ({
  runGws: mockRunGws,
}));

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getComposioApiKey: mockGetComposioApiKey,
    getGmailConnectionId: mockGetGmailConnectionId,
  };
});

vi.mock("@composio/core", () => ({
  Composio: class {
    getClient() {
      return {
        connectedAccounts: {
          get: vi.fn().mockResolvedValue({ status: "ACTIVE" }),
        },
      };
    }
  },
}));

describe("provider-probes", () => {
  beforeEach(() => {
    mockRunGws.mockReset();
    mockGetComposioApiKey.mockReturnValue("ck_test");
  });

  it("probeComposioGmail returns up when connection ACTIVE", async () => {
    const { probeComposioGmail } = await import("../../../src/infra/provider-probes.js");
    const r = await probeComposioGmail(5_000);
    expect(r.status).toBe("up");
  });

  it("probeComposioGmail returns unconfigured without API key", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined);
    const { probeComposioGmail } = await import("../../../src/infra/provider-probes.js");
    const r = await probeComposioGmail(5_000);
    expect(r.status).toBe("unconfigured");
  });

  it("probeGwsGmail returns up when list succeeds", async () => {
    mockRunGws.mockResolvedValueOnce({ ok: true, stdout: "{}", parsed: {} });
    mockRunGws.mockResolvedValueOnce({ ok: true, stdout: "{}", parsed: { messages: [] } });
    const { probeGwsGmail } = await import("../../../src/infra/provider-probes.js");
    const r = await probeGwsGmail(5_000);
    expect(r.status).toBe("up");
  });

  it("formatProviderStatusLine includes backend name", async () => {
    const { formatProviderStatusLine } = await import("../../../src/infra/provider-probes.js");
    const line = formatProviderStatusLine({
      checked_at: new Date().toISOString(),
      gmail_backend: "composio",
      composio_gmail: { status: "up", detail: "ok" },
      gws_gmail: { status: "unconfigured", detail: "skip" },
      active_gmail: { status: "up", detail: "Gmail connection ACTIVE" },
    });
    expect(line).toContain("composio");
    expect(line).toContain("🟢");
  });
});
