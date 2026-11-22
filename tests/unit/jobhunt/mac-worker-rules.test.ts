/**
 * Mac worker rules: the pure parts. macOnline (30 min), the constant-time bearer check, which hand_off reasons the Mac
 * may lease, and the result body's shape.
 */

import { describe, expect, it } from "vitest";
import {
  bearerOf, isMacEligibleReason, MAC_ONLINE_MS, macOnline, parseResultBody, tokenMatches,
} from "../../../src/tools/jobhunt/mac-worker-rules.js";

const NOW = new Date("2026-11-22T12:00:00Z");
const ROW = "11111111-2222-4333-8444-555555555555";

describe("macOnline", () => {
  it("is offline when the Mac never checked in", () => {
    expect(macOnline(null, NOW)).toBe(false);
    expect(macOnline(undefined, NOW)).toBe(false);
  });
  it("is online up to and including 30 minutes after the last beat, offline after", () => {
    expect(macOnline(new Date(NOW.getTime() - 60_000), NOW)).toBe(true);
    expect(macOnline(new Date(NOW.getTime() - MAC_ONLINE_MS), NOW)).toBe(true);
    expect(macOnline(new Date(NOW.getTime() - MAC_ONLINE_MS - 1), NOW)).toBe(false);
  });
  it("treats a beat from the future (clock skew) as offline rather than online forever", () => {
    expect(macOnline(new Date(NOW.getTime() + 60_000), NOW)).toBe(false);
  });
});

describe("tokenMatches / bearerOf", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches("s3cret-token", "s3cret-token")).toBe(true);
    expect(tokenMatches("s3cret-tokeN", "s3cret-token")).toBe(false);
    expect(tokenMatches("s3cret", "s3cret-token")).toBe(false);
    expect(tokenMatches("", "s3cret-token")).toBe(false);
    expect(tokenMatches(undefined, "s3cret-token")).toBe(false);
  });
  it("reads the Authorization header", () => {
    expect(bearerOf("Bearer abc123")).toBe("abc123");
    expect(bearerOf("bearer abc123")).toBe("abc123");
    expect(bearerOf("Basic abc123")).toBeUndefined();
    expect(bearerOf("Bearer ")).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
  });
});

describe("isMacEligibleReason", () => {
  it("takes the lane's CAPTCHA and bot-check reasons", () => {
    expect(isMacEligibleReason("CAPTCHA or reCAPTCHA widget on the form; a person has to solve it")).toBe(true);
    expect(isMacEligibleReason("Bot check blocks automation: hCaptcha on the submit step")).toBe(true);
    expect(isMacEligibleReason("Cloudflare Turnstile challenge")).toBe(true);
  });
  it("leaves Workday, expired, unusable forms and no reason alone", () => {
    expect(isMacEligibleReason("Workday: needs an account")).toBe(false);
    expect(isMacEligibleReason("Expired: posting closed")).toBe(false);
    expect(isMacEligibleReason("Form not usable: no form")).toBe(false);
    expect(isMacEligibleReason(null)).toBe(false);
  });
});

describe("parseResultBody", () => {
  const ok = { rowId: ROW, leaseId: "lease-0001-abcd", outcome: "confirmed", detail: "thanks page seen" };
  it("accepts every outcome and defaults detail", () => {
    for (const outcome of ["confirmed", "challenge", "failed", "code_needed"]) {
      expect(parseResultBody(JSON.stringify({ ...ok, outcome })).ok).toBe(true);
    }
    const bare = parseResultBody(JSON.stringify({ rowId: ROW, leaseId: ok.leaseId, outcome: "failed" }));
    expect(bare.ok && bare.body.detail).toBe("");
  });
  it("rejects bad JSON, an unknown outcome, a bad row id and a missing lease", () => {
    expect(parseResultBody("{nope").ok).toBe(false);
    expect(parseResultBody(JSON.stringify({ ...ok, outcome: "sent" })).ok).toBe(false);
    expect(parseResultBody(JSON.stringify({ ...ok, rowId: "not-a-uuid" })).ok).toBe(false);
    expect(parseResultBody(JSON.stringify({ rowId: ROW, outcome: "failed" })).ok).toBe(false);
  });
});
