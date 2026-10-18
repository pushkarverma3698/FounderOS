/**
 * Telegram Mini App initData verification: good, tampered, stale, unknown user, and the sender to profile mapping.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticateMiniApp, verifyInitData } from "../../../src/gateway/miniapp-auth.js";

const BOT = "123456:TEST-bot-token";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const AUTH = Math.floor(NOW / 1000) - 60;
const SENDERS = "111=pushkar,222=wife";

/** Builds a signed initData string the way Telegram does. */
function sign(fields: Record<string, string>, token = BOT): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const userField = (id: number): string => JSON.stringify({ id, first_name: "T" });
const good = (id = 111, authDate = AUTH): string => sign({ auth_date: String(authDate), query_id: "AAH", user: userField(id) });
const future = Math.floor(NOW / 1000) + 600;
const old = Math.floor(NOW / 1000) - 3601;

describe("verifyInitData", () => {
  it("accepts a correctly signed, fresh payload and returns the user id", () => {
    expect(verifyInitData(good(), BOT, NOW)).toEqual({ ok: true, userId: 111, authDate: AUTH });
  });

  it("rejects a tampered field", () => {
    const tampered = good().replace(encodeURIComponent(userField(111)), encodeURIComponent(userField(222)));
    expect(tampered).not.toBe(good());
    expect(verifyInitData(tampered, BOT, NOW)).toEqual({ ok: false, reason: "bad-hash" });
  });

  it("rejects a payload signed with another bot token", () => {
    const other = sign({ auth_date: String(AUTH), user: userField(111) }, "999:other");
    expect(verifyInitData(other, BOT, NOW)).toEqual({ ok: false, reason: "bad-hash" });
  });

  it("rejects auth_date older than one hour, and one from the future", () => {
    expect(verifyInitData(good(111, old), BOT, NOW)).toEqual({ ok: false, reason: "stale" });
    expect(verifyInitData(good(111, future), BOT, NOW)).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects empty, hash-less and user-less input", () => {
    expect(verifyInitData("", BOT, NOW).ok).toBe(false);
    const noHash = `auth_date=${AUTH}&user=${encodeURIComponent(userField(1))}`;
    expect(verifyInitData(noHash, BOT, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyInitData(sign({ auth_date: String(AUTH) }), BOT, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("authenticateMiniApp", () => {
  const env = { JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: SENDERS };

  it("maps the founder id and the wife id to their own profiles", () => {
    expect(authenticateMiniApp(good(111), env, NOW)).toMatchObject({ ok: true, profileId: "pushkar-nl-tech" });
    expect(authenticateMiniApp(good(222), env, NOW)).toMatchObject({ ok: true, profileId: "wife-nl-finance" });
  });

  it("rejects a validly signed user that is not in JOBHUNT_SENDER_PROFILES", () => {
    expect(authenticateMiniApp(good(333), env, NOW)).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("rejects a missing header, a missing bot token and a missing map", () => {
    expect(authenticateMiniApp(undefined, env, NOW).ok).toBe(false);
    expect(authenticateMiniApp(good(), { JOBHUNT_SENDER_PROFILES: SENDERS }, NOW)).toEqual({ ok: false, reason: "no-bot-token" });
    expect(authenticateMiniApp(good(), { JOBS_BOT_TOKEN: BOT }, NOW)).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("falls back to TELEGRAM_BOT_TOKEN exactly like the jobs bot does", () => {
    const legacy = { TELEGRAM_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: SENDERS };
    expect(authenticateMiniApp(good(111), legacy, NOW).ok).toBe(true);
  });
});
