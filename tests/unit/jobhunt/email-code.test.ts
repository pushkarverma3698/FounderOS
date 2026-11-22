import { describe, expect, it } from "vitest";
import { extractEmailCode, parseEmailList, type CodeMail } from "../../../src/tools/jobhunt/email-code.js";

const SENT = Date.parse("2026-11-22T10:00:00Z");
const opts = { company: "Acme Robotics B.V.", sentAfter: SENT };

const mail = (over: Partial<CodeMail>): CodeMail => ({
  sender: "Greenhouse <no-reply@us.greenhouse-mail.io>",
  subject: "Security code for your application to Acme Robotics",
  body: "Copy and paste this code into the security code field on your application: k3Jd9sLm Once you enter the code, you can submit.",
  receivedAt: SENT + 30_000,
  ...over,
});

describe("extractEmailCode", () => {
  it("reads the code from an allowed sender, after the submit, naming the company", () => {
    expect(extractEmailCode([mail({})], opts)).toBe("k3Jd9sLm");
  });
  it("ignores a mail for a different company", () => {
    const other = mail({ subject: "Security code for your application to Globex", body: "Copy this security code: Zx81QwErT" });
    expect(extractEmailCode([other], opts)).toBeNull();
  });
  it("ignores a stale code received before the submit", () => {
    expect(extractEmailCode([mail({ receivedAt: SENT - 5 * 60_000 })], opts)).toBeNull();
  });
  it("returns null when two different codes arrive (never guesses)", () => {
    const second = mail({ body: "Your security code: Qw3rTy9Z", receivedAt: SENT + 90_000 });
    expect(extractEmailCode([mail({}), second], opts)).toBeNull();
  });
  it("accepts the same code twice", () => {
    expect(extractEmailCode([mail({}), mail({ receivedAt: SENT + 40_000 })], opts)).toBe("k3Jd9sLm");
  });
  it("ignores a sender outside the allow-list, including a look-alike domain", () => {
    expect(extractEmailCode([mail({ sender: "Phish <x@greenhouse-mail.io.evil.com>" })], opts)).toBeNull();
    expect(extractEmailCode([mail({ sender: "Bob <bob@gmail.com>" })], opts)).toBeNull();
    expect(extractEmailCode([mail({ sender: "bob@notgreenhouse.io" })], opts)).toBeNull();
  });
  it("accepts a sender subdomain of an allowed domain", () => {
    expect(extractEmailCode([mail({ sender: "no-reply@mail.hire.lever.co" })], opts)).toBe("k3Jd9sLm");
  });
  it("finds a code in the subject line", () => {
    const m = mail({ subject: "Acme Robotics: your verification code is 482913", body: "" });
    expect(extractEmailCode([m], opts)).toBe("482913");
  });
  it("does not treat plain words or years as the code", () => {
    const m = mail({ body: "Enter the security code field. Sent in 2026 for Acme Robotics." });
    expect(extractEmailCode([m], opts)).toBeNull();
  });
  it("returns null for no mail", () => {
    expect(extractEmailCode([], opts)).toBeNull();
  });
});

describe("parseEmailList", () => {
  it("parses the provider's formatted list", () => {
    const text =
      "1. From: Greenhouse <no-reply@us.greenhouse-mail.io> · Sun, 22 Nov 2026 10:01:00 +0000\n   Subject: Security code for Acme\n   Your security code: k3Jd9sLm\n" +
      "2. From: a@b.com · Sun, 22 Nov 2026 09:00:00 +0000\n   Subject: hi";
    const mails = parseEmailList(text);
    expect(mails).toHaveLength(2);
    expect(mails[0]).toMatchObject({ sender: "Greenhouse <no-reply@us.greenhouse-mail.io>", subject: "Security code for Acme" });
    expect(mails[0]!.receivedAt).toBe(Date.parse("2026-11-22T10:01:00Z"));
    expect(mails[0]!.body).toContain("k3Jd9sLm");
  });
  it("returns nothing for the no-results line", () => {
    expect(parseEmailList('No emails found matching "x".')).toEqual([]);
  });
});
