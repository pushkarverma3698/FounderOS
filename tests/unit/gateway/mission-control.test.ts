/**
 * MISO mission control — formatting + phase transitions.
 */

import { describe, it, expect } from "vitest";
import {
  formatMisoDashboard,
  formatElapsed,
  missionToView,
  phaseFromTrace,
  departmentFromRouteHint,
  PHASE_REACTION,
} from "../../../src/gateway/mission-control.js";
import type { Mission } from "../../../src/db/schema.js";

const baseMission: Mission = {
  mission_id: "550e8400-e29b-41d4-a716-446655440000",
  tenant_id: "turicks",
  session_id: "12345",
  thread_id: "turicks:12345",
  owner: "Pushkar",
  issue_ref: "42",
  goal: "Draft LinkedIn post on DevDay",
  scope: null,
  completion_criteria: null,
  risk: "low",
  phase: "RUNNING",
  department: "marketing",
  next_action: "route to marketing",
  agent_statuses: { marketing: "active", research: "idle" },
  telegram_msg_id: null,
  turn_id: null,
  started_at: new Date(Date.now() - 90_000),
  completed_at: null,
  created_at: new Date(),
};

describe("formatMisoDashboard", () => {
  it("includes required MISO header and footer frames", () => {
    const text = formatMisoDashboard(missionToView(baseMission));
    expect(text).toContain("🤖 MISSION CONTROL");
    expect(text).toContain("——————————————");
    expect(text).toContain("powered by FounderOS");
    expect(text).toContain("Draft LinkedIn post on DevDay");
    expect(text).toContain("↳ marketing: active");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute elapsed as seconds", () => {
    expect(formatElapsed(5000)).toMatch(/5s/);
  });
});

describe("phaseFromTrace", () => {
  it("maps hitl.interrupt to AWAITING APPROVAL", () => {
    expect(phaseFromTrace("hitl.interrupt")).toBe("AWAITING APPROVAL");
  });

  it("maps turn.error to ERROR", () => {
    expect(phaseFromTrace("turn.error")).toBe("ERROR");
  });
});

describe("departmentFromRouteHint", () => {
  it("extracts department from pre-router hint", () => {
    expect(departmentFromRouteHint("[Route directly to research department]")).toBe("research");
  });
});

describe("PHASE_REACTION", () => {
  it("uses eyes for awaiting approval", () => {
    expect(PHASE_REACTION["AWAITING APPROVAL"]).toBe("👀");
  });
});
