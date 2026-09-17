/**
 * AG-014 — a dead Google credential must reach the founder on a LIVE call, not
 * just at boot. `runProviderSmokeAtBoot` (provider-auth-alert.test.ts) only runs
 * once at process start; a grant that's fine at boot but revoked hours later
 * isn't caught until the next restart — which could be days. This tests the
 * live-call counterpart: classify + alert once per outage episode, deduped so a
 * burst of failed calls sends ONE Telegram message, not one per call (same
 * shape as judge-health.ts's alerted/reset pattern).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  alertOnCredentialFailure,
  clearCredentialAlert,
  _resetCredentialAlerts,
} from "../../../src/infra/provider-probes.js";

/** The exact detail string production logged on 2026-09-04 and 2026-09-06. */
const PROD_DETAIL =
  "gws authenticated but Gmail list failed: Using keyring backend: keyring\n" +
  "error[auth]: Authentication failed: Failed to get token: Server error: invalid_grant: Bad Request: invalid_grant: Bad Request";

beforeEach(() => _resetCredentialAlerts());

describe("alertOnCredentialFailure", () => {
  it("classifies a dead grant and sends exactly one alert", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const fired = await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    expect(fired).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain("Gmail");
  });

  it("does NOT alert on a transient failure — those self-heal", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const fired = await alertOnCredentialFailure("active_gmail", "HTTP 503 Service Unavailable", notify);
    expect(fired).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("dedupes within the same episode — a burst of failed calls sends ONE message", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("still classifies as a credential failure on repeat calls, even though it doesn't re-notify", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    const fired = await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    expect(fired).toBe(true); // caller still knows to use the re-auth message, just doesn't re-notify
  });

  it("alerts again after clearCredentialAlert (success ended the episode)", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    clearCredentialAlert("active_gmail");
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("tracks Gmail and Calendar as independent episodes", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    await alertOnCredentialFailure("active_calendar", PROD_DETAIL, notify);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("a Telegram send failure does not throw — fail-open, matches boot-alert behavior", async () => {
    const notify = vi.fn().mockRejectedValue(new Error("Telegram API down"));
    await expect(alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify)).resolves.toBe(true);
  });

  // Security review finding (2026-09-17): this app routes 3 real Google accounts
  // (turicks, personal, naggar — src/core/accounts.ts ACCOUNT_KEYS) through the
  // SAME gws backend and the SAME alert function — comms/sales/jobhunt each
  // resolve to a different account via DEPARTMENT_ACCOUNT_DEFAULTS. Deduping by
  // capability alone meant a second account's failure silently never alerted
  // once the first account's episode was open, and one account's SUCCESS
  // cleared the alert for a DIFFERENT account that was still broken.
  it("tracks the SAME capability on two different accounts as independent episodes", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "turicks");
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "personal");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("names the specific account in the alert text, not just the capability", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "personal");
    expect(notify.mock.calls[0]?.[0]).toContain("personal");
  });

  it("clearing one account's episode does NOT clear a different account's open episode", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "turicks");
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "personal");
    clearCredentialAlert("active_gmail", "turicks");
    // personal's episode is still open — a repeat failure must NOT re-notify (still deduped)...
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "personal");
    expect(notify).toHaveBeenCalledTimes(2);
    // ...but turicks's episode was cleared, so its next failure alerts again.
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify, "turicks");
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("still works with NO accountKey (backward compatible — treated as one shared episode)", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    await alertOnCredentialFailure("active_gmail", PROD_DETAIL, notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
