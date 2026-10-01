/**
 * Edge: the daily budget cap is reached.
 *
 * The 09:00 standup still sends, because it is $0 and nothing in its path consults the budget
 * (zero-llm.test.ts proves the import closure never reaches the budget guard). The "Plan next step"
 * button is different: it runs a kernel turn, and the REAL run loop refuses it at its budget gate. This drives the
 * real `runKernelText` (kernel and storage replaced, the run loop and its error replies real) from a real
 * button tap, and holds that the founder is told the cap is reached, not left with a button that does nothing.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => {
    throw new Error("the kernel must not be reached once the budget is spent");
  }),
}));
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: vi.fn(async () => null),
  resolveInterrupt: vi.fn(async () => ({})),
  getTodayCostUsd: vi.fn(async () => 1_000_000), // far above any cap
  logLlmCost: vi.fn(async () => undefined),
}));
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn(async () => null),
  formatHaltNotice: vi.fn(() => "halted"),
}));

const { runKernelText } = await import("../../../src/gateway/kernel-run.js");
import { handleGoalCallback } from "../../../src/gateway/goal-buttons.js";
import { buildChatAccessConfig } from "../../../src/gateway/chat-access.js";
import { encodeGoalCallback } from "../../../src/goals/callbacks.js";
import { OWNER, makeCtx, makeDeps, seedGoal } from "../../helpers/goal-gateway.js";
import type { Context } from "grammy";
import { getKernel } from "../../../src/gateway/kernel-boot.js";

describe("Plan next step with the daily budget spent", () => {
  it("says the budget cap is reached, runs no kernel, and lets the founder tap again later", async () => {
    const h = makeDeps({ runKernelText: (ctx: Context, text: string) => runKernelText(ctx, text) });
    const g = await seedGoal(h, { title: "Tashi applies" });
    const access = buildChatAccessConfig({ primaryChatId: String(OWNER) });
    const c = makeCtx({ callback: { data: encodeGoalCallback({ kind: "plan", goalId: g.id }) as string } });

    expect(await handleGoalCallback(c.ctx, access, h.deps)).toBe(true);

    await vi.waitFor(() => expect(c.replies.some((r) => /budget cap reached/i.test(r.text))).toBe(true));
    expect(getKernel).not.toHaveBeenCalled();
    // The run ended, so the goal is free again: a later tap (after the cap resets) is not refused as "already planning".
    await vi.waitFor(() => expect(h.deps.planGuard.tryStart(g.id)).toBe(true));
  });
});
