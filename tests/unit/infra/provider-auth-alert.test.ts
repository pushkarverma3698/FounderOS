/**
 * A dead Google credential must reach the founder, not just the journal.
 *
 * WHAT WAS BROKEN (issue #426 item 4, open since 2026-08-08). Gmail and
 * Calendar authentication failed twice in the 2026-09-02 → 09-07 window
 * (Sep 4 and Sep 6), each time with `invalid_grant: Bad Request` from the boot
 * probe. The probe's only response was `log.warn` — nothing told the founder,
 * so the sole way to learn that email and calendar were off was to grep the
 * journal, which is exactly how the QA audit found it days later.
 *
 * A refresh token that has been revoked or expired cannot self-heal: nobody but
 * the founder can re-authorise it. That makes it the one class of provider
 * failure worth interrupting him for, and the reason the filter below is
 * narrow. A timeout or a 503 is noise — it will be gone by the next probe, and
 * an alert on it teaches him to ignore the channel.
 */

import { describe, it, expect } from "vitest";
import {
  isCredentialFailure,
  formatProviderAuthAlert,
} from "../../../src/infra/provider-probes.js";

/** The exact detail string production logged on 2026-09-04 and 2026-09-06. */
const PROD_DETAIL =
  "gws authenticated but Gmail list failed: Using keyring backend: keyring\n" +
  "error[auth]: Authentication failed: Failed to get token: Server error: invalid_grant: Bad Request: invalid_grant: Bad Request";

describe("isCredentialFailure", () => {
  it("recognises the invalid_grant production actually logged", () => {
    expect(isCredentialFailure(PROD_DETAIL)).toBe(true);
  });

  it("recognises the other shapes an expired or revoked grant takes", () => {
    expect(isCredentialFailure("HTTP 401 Unauthorized")).toBe(true);
    expect(isCredentialFailure("403 Forbidden: insufficient permissions")).toBe(true);
    expect(isCredentialFailure("invalid_client")).toBe(true);
    expect(isCredentialFailure("Token has been expired or revoked.")).toBe(true);
  });

  it("does NOT fire on transients — those self-heal and would train him to ignore the alert", () => {
    expect(isCredentialFailure("connect ETIMEDOUT 142.250.185.10:443")).toBe(false);
    expect(isCredentialFailure("HTTP 503 Service Unavailable")).toBe(false);
    expect(isCredentialFailure("socket hang up")).toBe(false);
    expect(isCredentialFailure("HTTP 429 Too Many Requests")).toBe(false);
  });

  it("does not fire on an empty or missing detail", () => {
    expect(isCredentialFailure(undefined)).toBe(false);
    expect(isCredentialFailure("")).toBe(false);
  });
});

describe("formatProviderAuthAlert", () => {
  it("names every affected capability in one message, not one message each", () => {
    const msg = formatProviderAuthAlert([
      { provider: "active_gmail", detail: PROD_DETAIL },
      { provider: "active_calendar", detail: PROD_DETAIL },
    ]);
    expect(msg).toContain("Gmail");
    expect(msg).toContain("Calendar");
  });

  it("says what stopped working in plain words, not the probe's internal name", () => {
    const msg = formatProviderAuthAlert([{ provider: "active_gmail", detail: PROD_DETAIL }]);
    expect(msg).not.toContain("active_gmail");
  });

  it("tells the founder the action only he can take", () => {
    const msg = formatProviderAuthAlert([{ provider: "active_gmail", detail: PROD_DETAIL }]);
    expect(msg.toLowerCase()).toMatch(/re-?authoris|re-?authoriz|reconnect|sign in again/);
  });

  it("carries the raw error so the cause is not lost in the translation", () => {
    const msg = formatProviderAuthAlert([{ provider: "active_gmail", detail: PROD_DETAIL }]);
    expect(msg).toContain("invalid_grant");
  });

  it("is empty for an empty list — nothing to say, nothing sent", () => {
    expect(formatProviderAuthAlert([])).toBe("");
  });
});
