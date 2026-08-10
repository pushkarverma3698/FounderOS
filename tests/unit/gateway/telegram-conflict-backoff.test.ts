/**
 * Telegram 409 conflict handling — the crash loop of 2026-08-08/09.
 *
 * WHAT HAPPENED. `bot.start()`'s rejection handler called `process.exit(1)` for
 * ANY polling error. Telegram returns `409 Conflict: terminated by other
 * getUpdates request` whenever a second consumer touches the same bot token —
 * a deploy overlapping itself, or a dev run pointed at the production token.
 * That is a TRANSIENT condition owned by the other process, but exiting turned
 * it into a hard restart, and systemd's `Restart=always` turned that into a
 * loop: 25 conflict crashes and 29 restarts across two windows on 2026-08-08
 * and one on 2026-08-09, during which the bot was down.
 *
 * The fix is to treat 409 as what it is — back off, let the other consumer
 * finish or die, and resume polling — while keeping every other polling error
 * fatal and loud, and still failing hard if the conflict never clears.
 */

import { describe, it, expect } from "vitest";
import {
  isConflictError,
  conflictBackoffMs,
  CONFLICT_MAX_ATTEMPTS,
} from "../../../src/gateway/telegram-poll.js";

describe("isConflictError", () => {
  it("recognises grammY's GrammyError shape by error_code", () => {
    expect(isConflictError({ error_code: 409, description: "Conflict: terminated" })).toBe(true);
  });

  it("recognises the 409 conflict from the message text alone", () => {
    // This is the exact string production logged 25 times.
    const err = new Error(
      "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; " +
        "make sure that only one bot instance is running)",
    );
    expect(isConflictError(err)).toBe(true);
  });

  it("does NOT treat other API errors as conflicts", () => {
    expect(isConflictError({ error_code: 401, description: "Unauthorized" })).toBe(false);
    expect(isConflictError({ error_code: 400, description: "Bad Request: query is too old" })).toBe(
      false,
    );
    expect(isConflictError(new Error("getaddrinfo ENOTFOUND api.telegram.org"))).toBe(false);
  });

  it("does not mistake an unrelated 409 in prose for a polling conflict", () => {
    expect(isConflictError(new Error("uploaded 409 files"))).toBe(false);
  });

  it("survives null/undefined without throwing", () => {
    expect(isConflictError(null)).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
  });
});

describe("conflictBackoffMs", () => {
  it("grows exponentially from the base delay", () => {
    expect(conflictBackoffMs(1, 2000)).toBe(2000);
    expect(conflictBackoffMs(2, 2000)).toBe(4000);
    expect(conflictBackoffMs(3, 2000)).toBe(8000);
  });

  it("caps so a long conflict never parks the bot for hours", () => {
    expect(conflictBackoffMs(20, 2000)).toBeLessThanOrEqual(60_000);
  });

  it("is bounded below by the base delay — never a hot loop", () => {
    for (let attempt = 1; attempt <= CONFLICT_MAX_ATTEMPTS; attempt += 1) {
      expect(conflictBackoffMs(attempt, 2000)).toBeGreaterThanOrEqual(2000);
    }
  });

  it("total wait across all attempts exceeds a deploy's overlap window", () => {
    // A restart takes seconds; the retry budget must comfortably outlast it,
    // otherwise the fix just moves the crash later.
    let total = 0;
    for (let attempt = 1; attempt <= CONFLICT_MAX_ATTEMPTS; attempt += 1) {
      total += conflictBackoffMs(attempt, 2000);
    }
    expect(total).toBeGreaterThan(30_000);
  });
});
