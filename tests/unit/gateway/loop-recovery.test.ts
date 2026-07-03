/**
 * Unit tests for loop-recovery (src/gateway/loop-recovery.ts)
 * ===========================================================
 * The founder's launch requirement: when a hard task makes the office loop
 * (supervisor re-transfers between departments until the recursion limit), the
 * system must NOT just abort — it must attempt ONE bounded recovery pass that
 * forces single-pass synthesis and, if that produces a real answer, DELIVER it
 * (task ultimately completed). Only if recovery ALSO fails does it stop and tell
 * the founder to break the ask down.
 *
 * These cover the pure decision logic + the injectable orchestrator (rule #16 /
 * #19.3 — the loop-break behaviour is a pure function with a fake invoke, never a
 * prompt instruction the weak model may ignore).
 */

import { describe, it, expect } from "vitest";
import {
  buildRecoveryInput,
  isUsableRecoveryReply,
  attemptLoopRecovery,
  LOOP_RECOVERY_DIRECTIVE,
  LOOP_RECOVERY_FAILED_MESSAGE,
  RECOVERY_RECURSION_LIMIT,
} from "../../../src/gateway/loop-recovery.js";

describe("buildRecoveryInput", () => {
  it("prepends the single-pass synthesis directive and preserves the original ask", () => {
    const out = buildRecoveryInput("What does Turicks do? Then Naggar? Then which wins?");
    expect(out).toContain(LOOP_RECOVERY_DIRECTIVE);
    expect(out).toContain("What does Turicks do?");
    expect(out).toContain("Naggar");
  });

  it("directive forbids re-transferring more than once (the loop root cause)", () => {
    expect(LOOP_RECOVERY_DIRECTIVE.toLowerCase()).toMatch(/transfer/);
    expect(LOOP_RECOVERY_DIRECTIVE.toLowerCase()).toMatch(/(once|single pass|one pass)/);
  });
});

describe("RECOVERY_RECURSION_LIMIT", () => {
  it("is small so a second loop is cheap and bounded", () => {
    expect(RECOVERY_RECURSION_LIMIT).toBeGreaterThan(0);
    expect(RECOVERY_RECURSION_LIMIT).toBeLessThanOrEqual(12);
  });
});

describe("isUsableRecoveryReply", () => {
  it("accepts a substantive answer", () => {
    expect(isUsableRecoveryReply("Turicks is an AI agency; Naggar is a retreat. Turicks wins on scalability.")).toBe(true);
  });

  it("rejects an empty or trivial reply", () => {
    expect(isUsableRecoveryReply("")).toBe(false);
    expect(isUsableRecoveryReply("   ")).toBe(false);
    expect(isUsableRecoveryReply("ok")).toBe(false);
  });

  it("rejects a reply that is itself another stuck/loop notice", () => {
    expect(isUsableRecoveryReply("🔁 I got stuck in a loop on that one and stopped.")).toBe(false);
    expect(isUsableRecoveryReply("Stopped to avoid runaway cost.")).toBe(false);
  });
});

describe("attemptLoopRecovery", () => {
  it("returns recovered + the reply when the recovery pass produces a real answer", async () => {
    const outcome = await attemptLoopRecovery(async () => "Turicks: AI agency. Naggar: retreat. Turicks wins.");
    expect(outcome.status).toBe("recovered");
    expect(outcome.reply).toContain("Turicks");
  });

  it("returns failed when the recovery pass yields an unusable reply", async () => {
    const outcome = await attemptLoopRecovery(async () => "");
    expect(outcome.status).toBe("failed");
    expect(outcome.reply).toBeUndefined();
  });

  it("returns failed (never throws) when the recovery pass itself loops/throws", async () => {
    const outcome = await attemptLoopRecovery(async () => {
      throw new Error("GraphRecursionError: Recursion limit of 8 reached");
    });
    expect(outcome.status).toBe("failed");
  });

  it("exposes a founder-facing failure message that asks to break the task down", () => {
    expect(LOOP_RECOVERY_FAILED_MESSAGE.toLowerCase()).toMatch(/smaller|break|one (question|step|at a time)/);
  });
});
