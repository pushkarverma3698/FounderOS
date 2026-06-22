/**
 * Web-path concurrency audit — the JARVIS web gateway must serialize office
 * runs per session exactly like Telegram does, or two concurrent turns on the
 * same session race the LangGraph Postgres checkpointer (lost/overwritten state).
 *
 * Regression: `runOfficeText` (Telegram) wrapped `runOfficeSession` in
 * `withChatTurnLock`, but `web.ts` calls `runOfficeSession`/`resumeOfficeSession`
 * directly — so the web path had NO per-session lock. The lock now lives inside
 * the transport-neutral functions, so both transports are serialized.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track how many office.invoke calls run concurrently. A correct per-session
// lock keeps this at 1 for same-session turns and allows >1 across sessions.
const tracker = vi.hoisted(() => {
  const state = { active: 0, maxConcurrent: 0 };
  const fakeOffice = {
    getState: () => Promise.resolve({ values: { messages: [] } }),
    invoke: async () => {
      state.active += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
      await new Promise((r) => setTimeout(r, 25));
      state.active -= 1;
      return { messages: [{ content: "ok", _getType: () => "ai" }] };
    },
  };
  return { state, fakeOffice };
});

vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return {
    ...actual,
    getOffice: vi.fn().mockResolvedValue(tracker.fakeOffice),
    getPendingApproval: vi.fn().mockResolvedValue(null),
  };
});

// Neutralize the three thread guards + fast paths so the audit isolates the lock.
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn().mockResolvedValue(null),
  formatHaltNotice: vi.fn().mockReturnValue(""),
}));
vi.mock("../../../src/gateway/inbox-fast-path.js", () => ({
  tryInboxReadFastPath: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../../src/gateway/github-read-fast-path.js", () => ({
  tryGithubReadFastPath: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../../src/db/queries.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/db/queries.js")>();
  return {
    ...actual,
    getTodayCostUsd: vi.fn().mockResolvedValue(0),
  };
});

import { runOfficeSession } from "../../../src/gateway/office-run.js";
import { createWebSession } from "../../../src/gateway/session.js";

describe("web gateway concurrency", () => {
  beforeEach(() => {
    tracker.state.active = 0;
    tracker.state.maxConcurrent = 0;
  });

  it("serializes concurrent runs on the SAME web session (no checkpoint race)", async () => {
    const session = createWebSession("race-1");
    await Promise.all([
      runOfficeSession(session, "first message"),
      runOfficeSession(session, "second message"),
    ]);
    expect(tracker.state.maxConcurrent).toBe(1);
  });

  it("allows different sessions to run concurrently", async () => {
    await Promise.all([
      runOfficeSession(createWebSession("dist-a"), "hello"),
      runOfficeSession(createWebSession("dist-b"), "hello"),
    ]);
    expect(tracker.state.maxConcurrent).toBe(2);
  });
});
