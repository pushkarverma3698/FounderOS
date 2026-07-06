/**
 * MISO mission sync — trace seams → mission phase/department state.
 *
 * Regression coverage for three live-prod findings (2026-07-04):
 *  1. `agent_statuses` never populated because department was derived from
 *     `route.decided`'s hint (fires before routing, never contains a dept name)
 *     instead of the actual `transfer_to_<dept>` tool.call.
 *  2. A successful `turn.out` left the mission phase at RUNNING forever
 *     instead of auto-completing.
 *  3. A department's status stayed "active" forever after the mission ended.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mission } from "../../../src/db/schema.js";
import type { TurnTrace } from "../../../src/infra/trace.js";

const updateMissionPhaseMock = vi.fn().mockResolvedValue(undefined);
let activeMission: Mission | null = null;

vi.mock("../../../src/db/queries.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/db/queries.js")>();
  return {
    ...actual,
    getActiveMission: vi.fn(async () => activeMission),
    updateMissionPhase: (...args: unknown[]) => updateMissionPhaseMock(...args),
    setMissionTelegramMsg: vi.fn().mockResolvedValue(undefined),
    getMissionById: vi.fn(async () => activeMission),
  };
});

vi.mock("../../../src/gateway/stream-hub.js", () => ({
  publishStreamEvent: vi.fn(),
}));

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    mission_id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "turicks",
    session_id: "12345",
    thread_id: "turicks:12345",
    owner: "Pushkar",
    issue_ref: null,
    goal: "Check the latest PR and summarize a news item",
    scope: null,
    completion_criteria: null,
    risk: "low",
    phase: "RUNNING",
    department: null,
    next_action: null,
    agent_statuses: {},
    telegram_msg_id: null,
    turn_id: null,
    started_at: new Date(),
    completed_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function fakeTrace(turnId = "turn-1"): TurnTrace {
  return {
    turnId,
    chatId: "12345",
    kind: "message",
    promptHash: "hash",
    events: [],
    event: vi.fn(),
  };
}

describe("syncMissionTrace — department detection", () => {
  beforeEach(() => {
    updateMissionPhaseMock.mockClear();
  });

  it("derives department from a transfer_to_<dept> tool.call, not route.decided's hint", async () => {
    activeMission = baseMission();
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "tool.call", { tool: "transfer_to_engineering" });

    expect(updateMissionPhaseMock).toHaveBeenCalledTimes(1);
    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch["department"]).toBe("engineering");
    expect(patch["agent_statuses"]).toMatchObject({ engineering: "active" });
  });

  it("ignores a nested sub-agent handoff that isn't a top-level department (transfer_to_coder)", async () => {
    activeMission = baseMission({ department: "engineering" });
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "tool.call", { tool: "transfer_to_coder" });

    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    // Department stays "engineering" (the last real top-level match) — not overwritten to null.
    expect(patch["department"]).toBe("engineering");
  });

  it("a route.decided hint (pre-routing directive text) never fabricates a department match", async () => {
    activeMission = baseMission();
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "route.decided", {
      hint: "[ROUTING DIRECTIVE: A deterministic classifier routed this turn]",
    });

    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch["department"]).toBeUndefined();
  });
});

describe("syncMissionTrace — terminal phase + agent status", () => {
  beforeEach(() => {
    updateMissionPhaseMock.mockClear();
  });

  it("a successful turn.out auto-completes the mission (was stuck at RUNNING)", async () => {
    activeMission = baseMission({ department: "research" });
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "turn.out", {});

    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch["phase"]).toBe("COMPLETE");
    expect(patch["completed_at"]).toBeInstanceOf(Date);
  });

  it("a rejected turn.out is CANCELLED, not COMPLETE", async () => {
    activeMission = baseMission({ department: "comms" });
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "turn.out", { rejected: true });

    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch["phase"]).toBe("CANCELLED");
  });

  it("flips the active department's status to done on successful completion (was stuck at 'active')", async () => {
    activeMission = baseMission({
      department: "engineering",
      agent_statuses: { engineering: "active" },
    });
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "turn.out", {});

    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch["agent_statuses"]).toMatchObject({ engineering: "done" });
  });

  it("flips the active department's status to error on turn.error", async () => {
    activeMission = baseMission({
      department: "engineering",
      agent_statuses: { engineering: "active" },
    });
    const { syncMissionTrace } = await import("../../../src/gateway/mission-sync.js");

    await syncMissionTrace("12345", fakeTrace(), "turn.error", { kind: "TurnTimeoutError" });

    const patch = updateMissionPhaseMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch["phase"]).toBe("ERROR");
    expect(patch["agent_statuses"]).toMatchObject({ engineering: "error" });
  });
});
