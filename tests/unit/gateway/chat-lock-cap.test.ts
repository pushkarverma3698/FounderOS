/**
 * REGRESSION (L3) — chatTurnChains must not grow without bound.
 * ==================================================================
 * Each entry self-cleans once its turn finishes, so at rest the map is empty —
 * but nothing previously bounded how many DISTINCT keys could exist AT ONCE.
 * A burst of many different chat/session ids in flight simultaneously could
 * grow it without limit (worse before C2 was fixed, since an unauthenticated
 * caller could mint arbitrary session ids). MAX_CONCURRENT_CHAT_LOCKS is set
 * very small here (via env, read at module load) so the cap is reachable
 * without actually spawning hundreds of locks.
 *
 * This file sets the env var BEFORE importing office-run.js — config.ts reads
 * it once at module load, so it must happen first in this isolated test file.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";

const ORIGINAL = process.env["MAX_CONCURRENT_CHAT_LOCKS"];
process.env["MAX_CONCURRENT_CHAT_LOCKS"] = "3";

const { withChatTurnLock, TooManyConcurrentSessionsError, __resetChatTurnLocksForTests } = await import(
  "../../../src/gateway/office-run.js"
);

beforeEach(() => {
  __resetChatTurnLocksForTests();
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env["MAX_CONCURRENT_CHAT_LOCKS"];
  else process.env["MAX_CONCURRENT_CHAT_LOCKS"] = ORIGINAL;
});

/** Hold a lock open until `release()` is called — lets the test fill the map. */
function openLock(key: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = withChatTurnLock(key, () => held);
  return { release, done };
}

describe("withChatTurnLock — concurrent-session cap (L3)", () => {
  it("rejects a genuinely NEW distinct key once the cap is reached", async () => {
    const a = openLock("cap-a");
    const b = openLock("cap-b");
    const c = openLock("cap-c");
    // Give each lock a tick to register itself in the map before probing.
    await new Promise((r) => setTimeout(r, 5));

    await expect(withChatTurnLock("cap-d-new", async () => {})).rejects.toThrow(
      TooManyConcurrentSessionsError,
    );

    a.release();
    b.release();
    c.release();
    await Promise.all([a.done, b.done, c.done]);
  });

  it("does NOT reject a chat that already has an entry, even at the cap", async () => {
    const a = openLock("cap-a2");
    const b = openLock("cap-b2");
    const c = openLock("cap-c2");
    await new Promise((r) => setTimeout(r, 5));

    // Queuing MORE work behind an EXISTING key must still succeed.
    const queued = withChatTurnLock("cap-a2", async () => "ok");

    a.release();
    b.release();
    c.release();
    await Promise.all([a.done, b.done, c.done]);
    await expect(queued).resolves.toBe("ok");
  });

  it("frees capacity once a lock's turn completes (map self-cleans)", async () => {
    const a = openLock("cap-x");
    const b = openLock("cap-y");
    const c = openLock("cap-z");
    await new Promise((r) => setTimeout(r, 5));

    a.release();
    await a.done;

    // Capacity freed by cap-x completing — a new distinct key now fits.
    await expect(withChatTurnLock("cap-w", async () => "fits")).resolves.toBe("fits");

    b.release();
    c.release();
    await Promise.all([b.done, c.done]);
  });
});
