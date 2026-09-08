/**
 * The run budget must be able to STOP a run, not merely describe one.
 *
 * WHAT WAS BROKEN (prod, 2026-09-07, turn 7dd021d8, 21:55–21:56).
 * `BudgetGuardCallback.handleLLMEnd` threw `BudgetExceededError` when the cap
 * was breached. It is a LangChain `BaseCallbackHandler` method, and LangChain's
 * callback manager catches anything a handler throws and logs
 * "Error in handler BudgetGuardCallback, handleLLMEnd: …" — the exact line in
 * that evening's journal. The throw never reached `.invoke()`, so the dedicated
 * `catch (err instanceof BudgetExceededError)` in kernel-run.ts was structurally
 * unreachable. The 100,000-token cap was breached five times in one turn
 * (105k → 110k → 121k → 137k → 154k) and the run issued further LLM and tool
 * calls after every single breach, stopping only when it finished on its own.
 *
 * WHY THE OLD TESTS PASSED. tests/unit/infra/budget.test.ts calls
 * `cb.handleLLMEnd(...)` directly and asserts it rejects. It does reject — in
 * isolation. The defect lives entirely in the gap between "the handler throws"
 * and "the caller sees it", which a direct call cannot cross. The first test
 * below crosses it deliberately, and documents the swallow as the fixed
 * behaviour of the framework rather than as a thing to fix.
 *
 * THE FIX. Enforcement rides the AbortSignal — the same mechanism the turn
 * timeout already uses and LangChain does honour — so the accrual hook only has
 * to RECORD the breach, not propagate it.
 */

import { describe, it, expect, vi } from "vitest";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { HumanMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  BudgetGuardCallback,
  BudgetTracker,
  BudgetExceededError,
  enforceRunBudget,
} from "../../../src/infra/budget.js";

/** An LLMResult shaped the way Gemini reports usage. */
function geminiResult(promptTokens: number, outputTokens: number): LLMResult {
  return {
    generations: [
      [
        {
          text: "ok",
          generationInfo: {
            usage_metadata: { promptTokenCount: promptTokens, candidatesTokenCount: outputTokens },
          },
        },
      ],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
}

const SERIALIZED = { lc: 1, type: "not_implemented" as const, id: ["test", "model"] };

/** Dispatch one completed LLM call the way LangChain itself does. */
async function dispatchThroughLangChain(handler: BudgetGuardCallback, result: LLMResult): Promise<void> {
  const manager = CallbackManager.configure([handler]);
  const runManagers = await manager!.handleChatModelStart(SERIALIZED, [[new HumanMessage("hi")]]);
  await runManagers[0]!.handleLLMEnd(result);
}

describe("the framework swallows a throwing callback — this is why the throw alone is not a guard", () => {
  it("does not surface BudgetExceededError to the caller when dispatched through LangChain", async () => {
    const tracker = new BudgetTracker({ maxUsd: 0.000_001, maxTokens: 10 });
    const cb = new BudgetGuardCallback(tracker, "gemini-2.5-flash");

    // Direct call: rejects, which is what the old test asserted.
    await expect(cb.handleLLMEnd(geminiResult(50_000, 10_000))).rejects.toThrow(BudgetExceededError);

    // Through the real callback manager: resolves. Nothing propagates. This
    // line is the production bug, pinned.
    const fresh = new BudgetGuardCallback(
      new BudgetTracker({ maxUsd: 0.000_001, maxTokens: 10 }),
      "gemini-2.5-flash",
    );
    await expect(dispatchThroughLangChain(fresh, geminiResult(50_000, 10_000))).resolves.toBeUndefined();
  });
});

describe("enforceRunBudget — a breach aborts the run", () => {
  it("starts un-aborted and un-breached", () => {
    const budget = enforceRunBudget("gemini-2.5-flash", undefined, new BudgetTracker({ maxUsd: 1, maxTokens: 1_000_000 }));
    expect(budget.signal.aborted).toBe(false);
    expect(budget.breached).toBe(false);
    expect(budget.breachError()).toBeUndefined();
  });

  it("aborts the signal on a breach dispatched through LangChain's own manager", async () => {
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      undefined,
      new BudgetTracker({ maxUsd: 100, maxTokens: 1_000 }),
    );

    await dispatchThroughLangChain(budget.callback, geminiResult(900, 200));

    expect(budget.signal.aborted).toBe(true);
    expect(budget.breached).toBe(true);
  });

  it("names the token cap in the error the founder is shown", async () => {
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      undefined,
      new BudgetTracker({ maxUsd: 100, maxTokens: 1_000 }),
    );

    await dispatchThroughLangChain(budget.callback, geminiResult(900, 200));

    const err = budget.breachError();
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err!.reason).toContain("Token budget exceeded");
    expect(err!.reason).toContain("1,000");
  });

  it("still accrues to the cost sink on the call that breached — the ledger keeps it", async () => {
    const accrued: number[] = [];
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      (call) => accrued.push(call.inputTokens + call.outputTokens),
      new BudgetTracker({ maxUsd: 100, maxTokens: 1_000 }),
    );

    await dispatchThroughLangChain(budget.callback, geminiResult(900, 200));

    expect(accrued).toEqual([1_100]);
  });

  it("does not abort while the run is inside its caps", async () => {
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      undefined,
      new BudgetTracker({ maxUsd: 100, maxTokens: 1_000_000 }),
    );

    await dispatchThroughLangChain(budget.callback, geminiResult(900, 200));

    expect(budget.signal.aborted).toBe(false);
    expect(budget.breachError()).toBeUndefined();
  });

  it("records the FIRST breach only — later calls cannot rewrite why the run stopped", async () => {
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      undefined,
      new BudgetTracker({ maxUsd: 0.000_1, maxTokens: 1_000 }),
    );

    await dispatchThroughLangChain(budget.callback, geminiResult(900, 200));
    const first = budget.breachError()!.reason;
    await dispatchThroughLangChain(budget.callback, geminiResult(9_000, 2_000));

    expect(budget.breachError()!.reason).toBe(first);
  });

  it("abort() stops the run without claiming the budget did it", () => {
    const budget = enforceRunBudget("gemini-2.5-flash", undefined, new BudgetTracker({ maxUsd: 1, maxTokens: 1_000 }));

    budget.abort();

    expect(budget.signal.aborted).toBe(true);
    // A turn timeout must not be reported to the founder as a spend cap.
    expect(budget.breached).toBe(false);
    expect(budget.breachError()).toBeUndefined();
  });

  it("an aborted signal is what a LangChain stream actually observes", async () => {
    const budget = enforceRunBudget("gemini-2.5-flash", undefined, new BudgetTracker({ maxUsd: 100, maxTokens: 1_000 }));
    const onAbort = vi.fn();
    budget.signal.addEventListener("abort", onAbort);

    await dispatchThroughLangChain(budget.callback, geminiResult(900, 200));

    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
