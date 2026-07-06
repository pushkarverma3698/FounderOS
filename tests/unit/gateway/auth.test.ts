/**
 * REGRESSION (C1) — Telegram sender authorization.
 * ==================================================
 * Before this module existed, ANY Telegram user could drive the office and
 * approve their own HITL cards — nothing checked who sent an update. These
 * tests lock in the fail-safe default (founder's own chat is always
 * authorized) and the opt-in broadening via FOUNDER_TELEGRAM_IDS.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { founderTelegramIds, isAuthorizedTelegramUser } from "../../../src/gateway/auth.js";

const ORIGINAL_IDS = process.env["FOUNDER_TELEGRAM_IDS"];

describe("founderTelegramIds", () => {
  afterEach(() => {
    if (ORIGINAL_IDS === undefined) delete process.env["FOUNDER_TELEGRAM_IDS"];
    else process.env["FOUNDER_TELEGRAM_IDS"] = ORIGINAL_IDS;
  });

  it("defaults to TELEGRAM_CHAT_ID when FOUNDER_TELEGRAM_IDS is unset", () => {
    delete process.env["FOUNDER_TELEGRAM_IDS"];
    const ids = founderTelegramIds();
    // env.TELEGRAM_CHAT_ID is set by the test env bootstrap; assert it's present.
    expect(ids.size).toBeGreaterThan(0);
  });

  it("parses a comma-separated FOUNDER_TELEGRAM_IDS override", () => {
    process.env["FOUNDER_TELEGRAM_IDS"] = "111, 222 ,333";
    const ids = founderTelegramIds();
    expect(ids).toEqual(new Set(["111", "222", "333"]));
  });

  it("ignores empty entries from a trailing comma", () => {
    process.env["FOUNDER_TELEGRAM_IDS"] = "111,,";
    expect(founderTelegramIds()).toEqual(new Set(["111"]));
  });
});

describe("isAuthorizedTelegramUser", () => {
  beforeEach(() => {
    process.env["FOUNDER_TELEGRAM_IDS"] = "555";
  });
  afterEach(() => {
    if (ORIGINAL_IDS === undefined) delete process.env["FOUNDER_TELEGRAM_IDS"];
    else process.env["FOUNDER_TELEGRAM_IDS"] = ORIGINAL_IDS;
  });

  it("authorizes a sender whose from.id is on the list", () => {
    expect(isAuthorizedTelegramUser({ from: { id: 555 } })).toBe(true);
  });

  it("authorizes a sender whose chat.id is on the list", () => {
    expect(isAuthorizedTelegramUser({ chat: { id: 555 } })).toBe(true);
  });

  it("rejects a stranger — the core C1 regression", () => {
    expect(isAuthorizedTelegramUser({ from: { id: 9999999 }, chat: { id: 9999999 } })).toBe(false);
  });

  it("rejects an update with neither from nor chat", () => {
    expect(isAuthorizedTelegramUser({})).toBe(false);
  });

  it("falls back to TELEGRAM_CHAT_ID (still non-empty) when the override is blank", () => {
    process.env["FOUNDER_TELEGRAM_IDS"] = "   ";
    // founderTelegramIds() treats a blank override as unset and falls back to
    // the required TELEGRAM_CHAT_ID — the set is never empty at runtime, which
    // is what makes the ids.size===0 guard in isAuthorizedTelegramUser defensive
    // (belt-and-suspenders) rather than a normally-reachable branch.
    expect(founderTelegramIds().size).toBeGreaterThan(0);
  });
});
