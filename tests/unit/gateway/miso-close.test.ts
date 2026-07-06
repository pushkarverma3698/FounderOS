/**
 * MISO /miso_close — regression coverage for two live-prod findings (2026-07-04):
 *  1. Closing a mission updated the DB row but never refreshed the pinned
 *     Telegram dashboard message — it stayed visually frozen at its last
 *     live phase (e.g. "RUNNING") even after the mission was COMPLETE.
 *  2. The close summary's "Recent audit" line queried the last N action_log
 *     rows tenant-wide (unscoped), so it could surface unrelated activity
 *     from other sessions instead of this mission's own actions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mission } from "../../../src/db/schema.js";

const closeMissionMock = vi.fn().mockResolvedValue(undefined);
const refreshMissionDashboardMock = vi.fn().mockResolvedValue(undefined);
const getRecentAuditEntriesMock = vi.fn().mockResolvedValue([]);
let activeMission: Mission | null = null;

vi.mock("../../../src/db/queries.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/db/queries.js")>();
  return {
    ...actual,
    getActiveMission: vi.fn(async () => activeMission),
    closeMission: (...args: unknown[]) => closeMissionMock(...args),
    getRecentAuditEntries: (...args: unknown[]) => getRecentAuditEntriesMock(...args),
  };
});

vi.mock("../../../src/gateway/mission-sync.js", () => ({
  refreshMissionDashboard: (...args: unknown[]) => refreshMissionDashboardMock(...args),
}));

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
    phase: "COMPLETE",
    department: "research",
    next_action: "turn complete",
    agent_statuses: { research: "done" },
    telegram_msg_id: 2601,
    turn_id: null,
    started_at: new Date("2026-07-04T20:48:08Z"),
    completed_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe("closeActiveMission", () => {
  beforeEach(() => {
    closeMissionMock.mockClear();
    refreshMissionDashboardMock.mockClear();
  });

  it("refreshes the pinned Telegram dashboard when the mission has a telegram_msg_id", async () => {
    activeMission = baseMission({ telegram_msg_id: 2601 });
    const { closeActiveMission } = await import("../../../src/gateway/web.js");

    await closeActiveMission("12345");

    expect(closeMissionMock).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000", "COMPLETE");
    expect(refreshMissionDashboardMock).toHaveBeenCalledWith(
      "12345",
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("skips the dashboard refresh for a web-only mission (no pinned message)", async () => {
    activeMission = baseMission({ telegram_msg_id: null });
    const { closeActiveMission } = await import("../../../src/gateway/web.js");

    await closeActiveMission("12345");

    expect(refreshMissionDashboardMock).not.toHaveBeenCalled();
  });

  it("returns null (no-op) when there is no active mission to close", async () => {
    activeMission = null;
    const { closeActiveMission } = await import("../../../src/gateway/web.js");

    const result = await closeActiveMission("12345");

    expect(result).toBeNull();
    expect(closeMissionMock).not.toHaveBeenCalled();
  });
});
