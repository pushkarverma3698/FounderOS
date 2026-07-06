/**
 * REGRESSION (M5) — the daily-budget check is deliberately fail-open (a
 * telemetry outage must never block the founder — see daily-budget.ts), but
 * it previously only LOGGED the degradation. The founder had no way to know
 * a cost gate had silently no-op'd for that turn. notifyBudgetGateDegraded
 * must now also emit a visible system notice and a `gate.degraded` trace seam.
 */
import { describe, it, expect, vi } from "vitest";
import { notifyBudgetGateDegraded } from "../../../src/gateway/office-run.js";
import type { TurnTrace } from "../../../src/infra/trace.js";

function fakeTrace(): TurnTrace & { events: Array<{ seam: string; data?: unknown }> } {
  const events: Array<{ seam: string; data?: unknown }> = [];
  return {
    turnId: "t1",
    promptHash: "h1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: (seam: string, data?: unknown) => {
      events.push({ seam, data });
    },
    events,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("notifyBudgetGateDegraded (M5)", () => {
  it("emits a gate.degraded trace seam naming the daily_budget gate", async () => {
    const trace = fakeTrace();
    const onSystemNotice = vi.fn(async () => {});
    await notifyBudgetGateDegraded(
      { onSystemNotice } as never,
      trace,
      "chat-1",
      "new turn",
      "connection refused",
    );
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]!.seam).toBe("gate.degraded");
    expect(trace.events[0]!.data).toMatchObject({ gate: "daily_budget", context: "new turn" });
  });

  it("sends a founder-visible system notice, not just a log line", async () => {
    const trace = fakeTrace();
    const onSystemNotice = vi.fn(async () => {});
    await notifyBudgetGateDegraded(
      { onSystemNotice } as never,
      trace,
      "chat-1",
      "resume",
      "db down",
    );
    expect(onSystemNotice).toHaveBeenCalledTimes(1);
    const [notice] = onSystemNotice.mock.calls[0]!;
    expect(notice).toMatch(/budget check unavailable/i);
  });

  it("never throws even if the notice itself fails to send (best-effort)", async () => {
    const trace = fakeTrace();
    const onSystemNotice = vi.fn(async () => {
      throw new Error("telegram down");
    });
    await expect(
      notifyBudgetGateDegraded({ onSystemNotice } as never, trace, "chat-1", "new turn", "x"),
    ).resolves.toBeUndefined();
  });
});
