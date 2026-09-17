/**
 * AG-014 — live Gmail/Calendar calls must classify a dead grant, not just
 * return a generic tool error. `google-gws.ts` is the live backend (GMAIL_BACKEND
 * = CALENDAR_BACKEND = gws in prod, confirmed 2026-09-17). Before this fix, a
 * mid-session `invalid_grant` was indistinguishable from any other gws failure —
 * the founder learned about it only at the NEXT process restart's boot probe
 * (provider-auth-alert.test.ts), which could be days away.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunGws = vi.fn();
const mockAlertOnCredentialFailure = vi.fn();
const mockClearCredentialAlert = vi.fn();

vi.mock("../../../../src/infra/gws-runner.js", () => ({
  runGws: mockRunGws,
}));

vi.mock("../../../../src/infra/account-registry.js", () => ({
  getGoogleAccount: vi.fn().mockResolvedValue({
    ctx: { account_key: "default" },
    credentials: { gws_profile_dir: "/tmp/gws-test-profile" },
  }),
}));

vi.mock("../../../../src/infra/provider-probes.js", () => ({
  alertOnCredentialFailure: mockAlertOnCredentialFailure,
  clearCredentialAlert: mockClearCredentialAlert,
}));

const { gwsReadEmails, gwsSendEmail, gwsCreateCalendarEvent } = await import(
  "../../../../src/infra/providers/google-gws.js"
);

/** The exact detail string production logged on 2026-09-04 and 2026-09-06. */
const PROD_INVALID_GRANT =
  "Using keyring backend: keyring\n" +
  "error[auth]: Authentication failed: Failed to get token: Server error: invalid_grant: Bad Request: invalid_grant: Bad Request";

beforeEach(() => {
  mockRunGws.mockReset();
  mockAlertOnCredentialFailure.mockReset().mockResolvedValue(false);
  mockClearCredentialAlert.mockReset();
});

describe("gwsReadEmails", () => {
  it("returns a clear re-authorization message on a dead grant, not the raw gws error", async () => {
    mockAlertOnCredentialFailure.mockResolvedValue(true);
    mockRunGws.mockResolvedValue({ ok: false, error: PROD_INVALID_GRANT });

    const result = await gwsReadEmails({ query: "is:unread", max_results: 5 });

    expect(result.success).toBe(false);
    expect(result.error ?? "").not.toContain("keyring");
    expect((result.error ?? "").toLowerCase()).toContain("re-author");
    expect(mockAlertOnCredentialFailure).toHaveBeenCalledWith("active_gmail", PROD_INVALID_GRANT);
  });

  it("leaves a transient failure's error message unchanged — no behavior change for the common case", async () => {
    mockAlertOnCredentialFailure.mockResolvedValue(false);
    mockRunGws.mockResolvedValue({ ok: false, error: "ETIMEDOUT" });

    const result = await gwsReadEmails({ query: "is:unread", max_results: 5 });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("ETIMEDOUT");
  });

  it("clears the credential-alert episode on a successful list call", async () => {
    mockRunGws.mockResolvedValue({ ok: true, parsed: { messages: [] } });

    await gwsReadEmails({ query: "is:unread", max_results: 5 });

    expect(mockClearCredentialAlert).toHaveBeenCalledWith("active_gmail");
  });
});

describe("gwsSendEmail", () => {
  it("returns a clear re-authorization message on a dead grant", async () => {
    mockAlertOnCredentialFailure.mockResolvedValue(true);
    mockRunGws.mockResolvedValue({ ok: false, error: PROD_INVALID_GRANT });

    const result = await gwsSendEmail({ to: "a@b.com", subject: "hi", body: "hello" });

    expect(result.success).toBe(false);
    expect((result.error ?? "").toLowerCase()).toContain("re-author");
    expect(mockAlertOnCredentialFailure).toHaveBeenCalledWith("active_gmail", PROD_INVALID_GRANT);
  });

  it("leaves a transient failure's error message unchanged", async () => {
    mockAlertOnCredentialFailure.mockResolvedValue(false);
    mockRunGws.mockResolvedValue({ ok: false, error: "socket hang up" });

    const result = await gwsSendEmail({ to: "a@b.com", subject: "hi", body: "hello" });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("socket hang up");
  });
});

describe("gwsCreateCalendarEvent", () => {
  const input = {
    title: "Sync",
    start_datetime: "2026-09-18T10:00:00Z",
    end_datetime: "2026-09-18T10:30:00Z",
    timezone: "Europe/Amsterdam",
  };

  it("returns a clear re-authorization message on a dead grant, tagged as Calendar not Gmail", async () => {
    mockAlertOnCredentialFailure.mockResolvedValue(true);
    mockRunGws.mockResolvedValue({ ok: false, error: PROD_INVALID_GRANT });

    const result = await gwsCreateCalendarEvent(input);

    expect(result.success).toBe(false);
    expect((result.error ?? "").toLowerCase()).toContain("re-author");
    expect(mockAlertOnCredentialFailure).toHaveBeenCalledWith("active_calendar", PROD_INVALID_GRANT);
  });

  it("leaves a transient failure's error message unchanged", async () => {
    mockAlertOnCredentialFailure.mockResolvedValue(false);
    mockRunGws.mockResolvedValue({ ok: false, error: "503 Service Unavailable" });

    const result = await gwsCreateCalendarEvent(input);

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("503 Service Unavailable");
  });
});
