/**
 * Unit tests — provider probes (mocked Composio + gws)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunGws = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "ck_test");
const mockGetGmailConnectionId = vi.fn(() => "ca_test");
const mockGetLinkedInConnectionId = vi.fn(() => "ca_li_test");
/** Overridable per-test: what the mocked Composio client returns for connectedAccounts.get(). */
let mockConnectedAccountStatus: Record<string, unknown> = { status: "ACTIVE" };

vi.mock("../../../src/infra/gws-runner.js", () => ({
  runGws: mockRunGws,
}));

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getComposioApiKey: mockGetComposioApiKey,
    getGmailConnectionId: mockGetGmailConnectionId,
    getLinkedInConnectionId: mockGetLinkedInConnectionId,
  };
});

/** Overridable per-test: make connectedAccounts.get() reject (revoked-key class). */
let mockConnectedAccountError: Error | null = null;

// Instance-level resource surface — matches the installed @composio/core ≥0.10.
// getClient() exposes a DIFFERENT generated client; mocking that wrong shape is
// how the 2026-07-12 "connectedAccounts.get is not a function" prod crash stayed
// CI-green (composio-sdk-surface.test.ts pins the real SDK against drift).
vi.mock("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      get: vi.fn().mockImplementation(() =>
        mockConnectedAccountError
          ? Promise.reject(mockConnectedAccountError)
          : Promise.resolve(mockConnectedAccountStatus),
      ),
    };
  },
}));

describe("provider-probes", () => {
  beforeEach(() => {
    mockRunGws.mockReset();
    mockGetComposioApiKey.mockReturnValue("ck_test");
    mockConnectedAccountStatus = { status: "ACTIVE" };
    mockConnectedAccountError = null;
  });

  it("probeComposioGmail returns up when connection ACTIVE", async () => {
    const { probeComposioGmail } = await import("../../../src/infra/provider-probes.js");
    const r = await probeComposioGmail(5_000);
    expect(r.status).toBe("up");
  });

  it("probeComposioGmail returns unconfigured without API key", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined as unknown as string);
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

  it("probeGwsGmail returns unconfigured (not down) when the gws CLI is not installed", async () => {
    // gws-runner's ENOENT message — what an empty/missing GWS_BIN surfaces as.
    mockRunGws.mockResolvedValue({
      ok: false,
      error:
        "Gmail is not connected on this host (gws CLI not installed). Install googleworkspace/cli, run gws auth login, or set GMAIL_BACKEND=composio.",
    });
    const { probeGwsGmail } = await import("../../../src/infra/provider-probes.js");
    const r = await probeGwsGmail(5_000);
    expect(r.status).toBe("unconfigured");
  });

  // ── probeLinkedInComposio (2026-07-01 fix) ──────────────────────────────────
  //
  // Gap: probeComposioGmail does a REAL reachability check (connectedAccounts.get,
  // status === ACTIVE). probeLinkedInComposio only checked composioLinkedInConfigured()
  // — i.e. "is COMPOSIO_API_KEY present" — and reported "up" regardless of whether the
  // actual LinkedIn connection was revoked/inactive. This is exactly the shallow check
  // that let the documented Composio LinkedIn outage (LIMITATIONS.md §7 — "Composio key
  // was invalid in both dev and prod: email/linkedin/calendar down") go undetected by
  // /status's 🟢/🔴 indicator, which would have shown a false 🟢.

  it("probeLinkedInComposio returns up when the connection is ACTIVE (real reachability check)", async () => {
    mockConnectedAccountStatus = { status: "ACTIVE" };
    const { probeLinkedInComposio } = await import("../../../src/infra/provider-probes.js");
    const r = await probeLinkedInComposio(5_000);
    expect(r.status).toBe("up");
  });

  it("probeLinkedInComposio returns down when the connection is INACTIVE — the actual outage class", async () => {
    mockConnectedAccountStatus = { status: "INACTIVE" };
    const { probeLinkedInComposio } = await import("../../../src/infra/provider-probes.js");
    const r = await probeLinkedInComposio(5_000);
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/inactive/i);
  });

  it("probeLinkedInComposio returns down when the Composio API call itself fails (revoked key)", async () => {
    mockGetComposioApiKey.mockReturnValue("ck_test"); // configured, but the call below rejects
    mockConnectedAccountError = new Error("401 Unauthorized");
    const { probeLinkedInComposio } = await import("../../../src/infra/provider-probes.js");
    const r = await probeLinkedInComposio(5_000);
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/401|unauthorized/i);
  });

  it("probeLinkedInComposio returns unconfigured without an API key (unchanged behavior)", async () => {
    mockGetComposioApiKey.mockReturnValue(undefined as unknown as string);
    const { probeLinkedInComposio } = await import("../../../src/infra/provider-probes.js");
    const r = await probeLinkedInComposio(5_000);
    expect(r.status).toBe("unconfigured");
  });

  it("formatProviderStatusLine includes backend names", async () => {
    // formatProviderStatusLine calls getGmailBackend()/getLinkedInBackend()
    // LIVE — it ignores report.gmail_backend/linkedin_backend below entirely
    // — and those read process.env directly (falling back to this repo's real
    // .env file on disk when unset). Pin them explicitly so this test asserts
    // the function's behavior, not whatever backend this dev machine has
    // configured.
    const prevGmail = process.env["GMAIL_BACKEND"];
    const prevLinkedin = process.env["LINKEDIN_BACKEND"];
    process.env["GMAIL_BACKEND"] = "gws";
    process.env["LINKEDIN_BACKEND"] = "direct";
    const { formatProviderStatusLine } = await import("../../../src/infra/provider-probes.js");
    const line = formatProviderStatusLine({
      checked_at: new Date().toISOString(),
      gmail_backend: "gws",
      calendar_backend: "gws",
      linkedin_backend: "direct",
      composio_gmail: { status: "unconfigured", detail: "skip" },
      googleapis_gmail: { status: "unconfigured", detail: "skip" },
      gws_gmail: { status: "up", detail: "gws ok" },
      active_gmail: { status: "up", detail: "gws ok" },
      active_calendar: { status: "up", detail: "gws ok" },
      active_linkedin: { status: "up", detail: "LinkedIn direct configured" },
    });
    expect(line).toContain("gws");
    expect(line).toContain("direct");
    expect(line).toContain("🟢");

    if (prevGmail === undefined) delete process.env["GMAIL_BACKEND"];
    else process.env["GMAIL_BACKEND"] = prevGmail;
    if (prevLinkedin === undefined) delete process.env["LINKEDIN_BACKEND"];
    else process.env["LINKEDIN_BACKEND"] = prevLinkedin;
  });
});
