/**
 * Unit tests — provider probes (mocked gws)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunGws = vi.fn();
vi.mock("../../../src/infra/gws-runner.js", () => ({
  runGws: mockRunGws,
}));

vi.mock("../../../src/infra/providers/google-direct.js", () => ({
  googleapisConfigured: vi.fn(async () => false),
  directReadEmails: vi.fn(),
}));

describe("provider-probes", () => {
  beforeEach(() => {
    mockRunGws.mockReset();
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
        "Gmail is not connected on this host (gws CLI not installed). Install googleworkspace/cli, or run gws auth login.",
    });
    const { probeGwsGmail } = await import("../../../src/infra/provider-probes.js");
    const r = await probeGwsGmail(5_000);
    expect(r.status).toBe("unconfigured");
  });

  it("runProviderProbes reports gws + googleapis + the active capabilities, with no Composio entry", async () => {
    mockRunGws.mockResolvedValue({ ok: true, stdout: "{}", parsed: {} });
    const { runProviderProbes } = await import("../../../src/infra/provider-probes.js");
    const report = await runProviderProbes();
    expect(report.linkedin_backend).toBe("direct");
    expect(Object.keys(report).sort()).toEqual([
      "active_calendar",
      "active_gmail",
      "active_linkedin",
      "calendar_backend",
      "checked_at",
      "gmail_backend",
      "googleapis_gmail",
      "gws_gmail",
      "linkedin_backend",
    ]);
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
