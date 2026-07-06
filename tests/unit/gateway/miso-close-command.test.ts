/**
 * /miso_close Telegram command handler — regression coverage for the
 * "Recent audit" line being tenant-wide/unscoped instead of scoped to the
 * mission's own time window (2026-07-04 live-prod finding).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";
import type { Mission } from "../../../src/db/schema.js";

const closeActiveMissionMock = vi.fn().mockResolvedValue("🤖 MISSION CONTROL — Closed\n...");
const getRecentAuditEntriesMock = vi.fn().mockResolvedValue([]);
let activeMission: Mission | null = null;

vi.mock("../../../src/gateway/web.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/gateway/web.js")>();
  return {
    ...actual,
    closeActiveMission: (...args: unknown[]) => closeActiveMissionMock(...args),
  };
});

vi.mock("../../../src/db/queries.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/db/queries.js")>();
  return {
    ...actual,
    getActiveMission: vi.fn(async () => activeMission),
    getRecentAuditEntries: (...args: unknown[]) => getRecentAuditEntriesMock(...args),
  };
});

function fakeCtx(): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 12345 },
    from: { first_name: "Pushkar" },
    reply: vi.fn(async (msg: string) => {
      replies.push(msg);
    }),
  } as unknown as Context;
  return { ctx, replies };
}

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    mission_id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "turicks",
    session_id: "12345",
    thread_id: "turicks:12345",
    owner: "Pushkar",
    issue_ref: null,
    goal: "Search the web for a 2026 AI agent framework news item",
    scope: null,
    completion_criteria: null,
    risk: "low",
    phase: "RUNNING",
    department: "research",
    next_action: "turn complete",
    agent_statuses: { research: "active" },
    telegram_msg_id: 2601,
    turn_id: null,
    started_at: new Date("2026-07-04T20:48:08Z"),
    completed_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe("handleMisoClose", () => {
  beforeEach(() => {
    closeActiveMissionMock.mockClear();
    getRecentAuditEntriesMock.mockClear();
  });

  it("scopes the audit line to this mission's own started_at, not an unbounded tenant-wide query", async () => {
    activeMission = baseMission({ started_at: new Date("2026-07-04T20:48:08Z") });
    const { handleMisoClose } = await import("../../../src/gateway/commands.js");
    const { ctx } = fakeCtx();

    await handleMisoClose(ctx);

    expect(getRecentAuditEntriesMock).toHaveBeenCalledTimes(1);
    const [, , since] = getRecentAuditEntriesMock.mock.calls[0]!;
    expect(since).toEqual(new Date("2026-07-04T20:48:08Z"));
  });

  it("replies 'No active mission to close' when closeActiveMission returns null", async () => {
    activeMission = null;
    closeActiveMissionMock.mockResolvedValueOnce(null);
    const { handleMisoClose } = await import("../../../src/gateway/commands.js");
    const { ctx, replies } = fakeCtx();

    await handleMisoClose(ctx);

    expect(replies[0]).toMatch(/no active mission/i);
    expect(getRecentAuditEntriesMock).not.toHaveBeenCalled();
  });
});
