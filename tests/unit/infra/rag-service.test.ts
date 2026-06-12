/**
 * Unit tests for the Turicks Brain (vector RAG) service supervisor.
 *
 * The contract that matters: ensureRagService never throws, only launches when
 * the service is actually down, and reports readiness honestly. RAG being
 * unavailable must degrade answers, never crash the bot — these tests lock that.
 */

import { describe, it, expect, vi } from "vitest";
import { ensureRagService } from "../../../src/infra/rag-service.js";

const noSleep = async () => {};

describe("ensureRagService", () => {
  it("no-ops (no launch) when the service is already healthy", async () => {
    const launch = vi.fn();
    const ok = await ensureRagService({
      _isHealthy: async () => true,
      _launch: launch,
      _sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches the service when down, then returns true once it becomes healthy", async () => {
    const launch = vi.fn();
    let polls = 0;
    const ok = await ensureRagService({
      // down initially, healthy after the 2nd poll
      _isHealthy: async () => {
        if (polls === 0) return false; // initial pre-launch check
        return ++polls >= 3;
      },
      _launch: () => {
        polls = 1;
        launch();
      },
      _sleep: noSleep,
      pollMs: 1,
      readinessTimeoutMs: 10_000,
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(ok).toBe(true);
  });

  it("returns false (degraded, not thrown) when the service never comes up", async () => {
    const ok = await ensureRagService({
      _isHealthy: async () => false,
      _launch: () => {},
      _sleep: noSleep,
      pollMs: 1,
      readinessTimeoutMs: 0, // give up immediately after launch
    });
    expect(ok).toBe(false);
  });

  it("never throws even when launch itself fails", async () => {
    const ok = await ensureRagService({
      _isHealthy: async () => false,
      _launch: () => {
        throw new Error("spawn failed");
      },
      _sleep: noSleep,
      readinessTimeoutMs: 0,
    });
    expect(ok).toBe(false);
  });
});
