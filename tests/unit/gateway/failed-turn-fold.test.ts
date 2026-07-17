/**
 * failed-turn-fold — a hard-failed turn must not leave a phantom "executing"
 * mission in the checkpoint. Live 2026-07-13 8e045446: a turn that died on
 * model-chain exhaustion left mission.status="executing" (cursor mid-plan), so
 * the NEXT turn's progress stream showed the dead task's label ("🔧 comms:
 * Send a warm, brief 3-line thank you email…") for the whole planning window
 * while the founder had asked an unrelated research question.
 */
import { describe, it, expect, vi } from "vitest";
import { recordFailedTurnInHistory, type FoldableKernel } from "../../../src/gateway/failed-turn-fold.js";

const STALE_MISSION = {
  goal: "Send a warm, brief 3-line thank you email",
  status: "executing",
  plan: { goal: "Send a warm, brief 3-line thank you email", steps: [{ worker: "comms" }] },
  cursor: 1,
};

function kernelWith(values: Record<string, unknown> | undefined) {
  const updateState = vi.fn().mockResolvedValue(undefined);
  const kernel: FoldableKernel = {
    getState: vi.fn().mockResolvedValue(values === undefined ? undefined : { values }),
    updateState,
  };
  return { kernel, updateState };
}

describe("recordFailedTurnInHistory", () => {
  it("resets the stale executing mission to a terminal failed state", async () => {
    // Arrange
    const { kernel, updateState } = kernelWith({
      turn: { id: "t1", raw_input: "Research what Linear does", received_at: "2026-07-13T17:04:18Z" },
      mission: STALE_MISSION,
    });

    // Act
    await recordFailedTurnInHistory(kernel, {}, new Error("503 chain exhausted"));

    // Assert
    expect(updateState).toHaveBeenCalledTimes(1);
    const written = updateState.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(written["mission"]).toEqual({
      goal: STALE_MISSION.goal,
      status: "failed",
      plan: null,
      cursor: 0,
    });
  });

  it("keeps writing last_turn, failure, and reply alongside the mission reset", async () => {
    // Arrange
    const turn = { id: "t1", raw_input: "x", received_at: "2026-07-13T17:04:18Z" };
    const { kernel, updateState } = kernelWith({ turn, mission: STALE_MISSION });

    // Act
    await recordFailedTurnInHistory(kernel, {}, new Error("boom"));

    // Assert
    const written = updateState.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(written["last_turn"]).toEqual(turn);
    expect(written["failure"]).toMatchObject({ stage: "model", retryable: true });
    expect(written["reply"]).toContain("boom");
    expect(updateState.mock.calls[0]?.[2]).toBe("plan");
  });

  it("falls back to an empty goal when the checkpoint has no mission", async () => {
    // Arrange
    const { kernel, updateState } = kernelWith({ turn: { id: "t1" } });

    // Act
    await recordFailedTurnInHistory(kernel, {}, new Error("boom"));

    // Assert
    const written = updateState.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(written["mission"]).toEqual({ goal: "", status: "failed", plan: null, cursor: 0 });
  });

  it("does nothing when the checkpoint has no turn id", async () => {
    // Arrange
    const { kernel, updateState } = kernelWith({ mission: STALE_MISSION });

    // Act
    await recordFailedTurnInHistory(kernel, {}, new Error("boom"));

    // Assert
    expect(updateState).not.toHaveBeenCalled();
  });

  it("swallows fold errors — the founder error reply must still go out", async () => {
    // Arrange
    const kernel: FoldableKernel = {
      getState: vi.fn().mockRejectedValue(new Error("checkpointer down")),
      updateState: vi.fn(),
    };

    // Act + Assert
    await expect(recordFailedTurnInHistory(kernel, {}, new Error("boom"))).resolves.toBeUndefined();
  });
});
