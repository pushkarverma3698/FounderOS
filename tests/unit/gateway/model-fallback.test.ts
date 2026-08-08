/**
 * Kernel model fallback wrapper — TDD for the 2026-07-11 prod finding:
 * AGENT_FALLBACK_MODELS was configured on prod but NEVER engaged, because
 * kernel-boot injected the bare primary model (journalctl showed only
 * ChatGoogleGenerativeAI attempts, then "Kernel run failed", zero OpenRouter
 * attempts while the founder saw raw quota errors).
 *
 * The wrapper operates on the kernel's structural model interface
 * (invoke + optional bindTools), NOT LangChain's class hierarchy — which is
 * why it can preserve bindTools where the old withFallbacks approach could
 * not (model.ts "@deprecated getSupervisorModel" note).
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { withModelFallbacks } from "../../../src/gateway/model-fallback.js";
import { withModelRetry } from "../../../src/gateway/model-retry.js";
import type { KernelBindableModel, KernelTool } from "../../../src/kernel/index.js";

const MSGS: BaseMessage[] = [new HumanMessage("hi")];

/** Real prod error shape from the 2026-07-11 incident (429 + quota message). */
function quotaError(): Error {
  return Object.assign(
    new Error(
      "[GoogleGenerativeAI Error]: [429 Too Many Requests] You exceeded your current quota",
    ),
    { status: 429 },
  );
}

/** Auth failure — must fail LOUD, never burn the fallback chain (audit Run B). */
function authError(): Error {
  return Object.assign(new Error("401 Unauthorized"), { status: 401 });
}

function okModel(text: string): KernelBindableModel {
  return { invoke: vi.fn(async () => new AIMessage(text)) };
}

function failingModel(err: Error): KernelBindableModel {
  return {
    invoke: vi.fn(async () => {
      throw err;
    }),
  };
}

describe("withModelFallbacks", () => {
  it("returns the primary result and never touches fallbacks on success", async () => {
    const primary = okModel("primary");
    const fallback = okModel("fallback");
    const model = withModelFallbacks(primary, [fallback]);

    const reply = await model.invoke(MSGS);

    expect(reply.content).toBe("primary");
    expect(fallback.invoke).not.toHaveBeenCalled();
  });

  it("engages the fallback chain on a quota/5xx-class primary failure (the 2026-07-11 prod gap)", async () => {
    const primary = failingModel(quotaError());
    const fallback = okModel("fallback-reply");
    const model = withModelFallbacks(primary, [fallback]);

    const reply = await model.invoke(MSGS);

    expect(reply.content).toBe("fallback-reply");
    expect(primary.invoke).toHaveBeenCalledOnce();
  });

  it("walks the chain in order and skips fallbacks that also fail retriably", async () => {
    const primary = failingModel(quotaError());
    const deadFallback = failingModel(quotaError());
    const liveFallback = okModel("second-fallback");
    const model = withModelFallbacks(primary, [deadFallback, liveFallback]);

    const reply = await model.invoke(MSGS);

    expect(reply.content).toBe("second-fallback");
    expect(deadFallback.invoke).toHaveBeenCalledOnce();
  });

  it("fails LOUD on auth errors — 401 must never engage the chain (shared-key misconfig would be hidden)", async () => {
    const primary = failingModel(authError());
    const fallback = okModel("should-not-run");
    const model = withModelFallbacks(primary, [fallback]);

    await expect(model.invoke(MSGS)).rejects.toThrow("401");
    expect(fallback.invoke).not.toHaveBeenCalled();
  });

  it("retries the primary ONCE after chain exhaustion, then throws (chain fully down)", async () => {
    // 2026-07-12 68eae59d: the free fallbacks share daily limits and often 429
    // together while the primary's 503 is a seconds-long spike — the chain must
    // give the primary one more shot before killing the founder's turn.
    const primary = failingModel(quotaError());
    const fallback = failingModel(
      Object.assign(new Error("503 Service Unavailable"), { status: 503 }),
    );
    const model = withModelFallbacks(primary, [fallback], "kernel", { primaryRetryDelayMs: 0 });

    await expect(model.invoke(MSGS)).rejects.toThrow("429");
    expect(primary.invoke).toHaveBeenCalledTimes(2);
    expect(fallback.invoke).toHaveBeenCalledTimes(1);
  });

  it("recovers the turn when the primary's transient failure clears on the post-chain retry (68eae59d)", async () => {
    let calls = 0;
    const primary: KernelBindableModel = {
      invoke: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("[503 Service Unavailable] high demand"), { status: 503 });
        }
        return new AIMessage("primary-recovered");
      }),
    };
    const fallback = failingModel(quotaError());
    const model = withModelFallbacks(primary, [fallback], "kernel", { primaryRetryDelayMs: 0 });

    const reply = await model.invoke(MSGS);

    expect(reply.content).toBe("primary-recovered");
    expect(primary.invoke).toHaveBeenCalledTimes(2);
  });

  it("returns the primary untouched when no fallbacks are configured", () => {
    const primary = okModel("primary");
    expect(withModelFallbacks(primary, [])).toBe(primary);
  });

  it("preserves bindTools: binding propagates to every model and the BOUND chain still falls back", async () => {
    const tools: KernelTool[] = [{ name: "t1", invoke: async () => "ok" }];

    const boundPrimary = failingModel(quotaError());
    const primary: KernelBindableModel = {
      invoke: vi.fn(async () => new AIMessage("unbound-primary")),
      bindTools: vi.fn(() => boundPrimary),
    };
    const boundFallback = okModel("bound-fallback");
    const fallback: KernelBindableModel = {
      invoke: vi.fn(async () => new AIMessage("unbound-fallback")),
      bindTools: vi.fn(() => boundFallback),
    };

    const model = withModelFallbacks(primary, [fallback]);
    const bound = model.bindTools!(tools);
    const reply = await bound.invoke(MSGS);

    expect(primary.bindTools).toHaveBeenCalledWith(tools);
    expect(fallback.bindTools).toHaveBeenCalledWith(tools);
    expect(reply.content).toBe("bound-fallback");
    // Unbound models must not have been invoked at all.
    expect(primary.invoke).not.toHaveBeenCalled();
    expect(fallback.invoke).not.toHaveBeenCalled();
  });

  it("a fallback without bindTools is used as-is in the bound chain (scripted-model compatibility)", async () => {
    const tools: KernelTool[] = [{ name: "t1", invoke: async () => "ok" }];
    const primary: KernelBindableModel = {
      invoke: async () => {
        throw quotaError();
      },
      bindTools: () => failingModel(quotaError()),
    };
    const plainFallback = okModel("plain"); // no bindTools — fakes return self
    const model = withModelFallbacks(primary, [plainFallback]);

    const reply = await model.bindTools!(tools).invoke(MSGS);
    expect(reply.content).toBe("plain");
  });
});

describe("withModelFallbacks — resolution budget + per-attempt deadlines (2026-07-17 503-storm incident)", () => {
  // Prod trace 16:53–17:03 UTC: planner retries + fallback chain + post-chain
  // primary retry summed past the 300s turn watchdog on EVERY turn, so the
  // founder saw generic 5-minute hangs instead of the real provider error.
  // The chain must be time-bounded end to end.
  it("caps a HUNG fallback with the attempt deadline and moves to the next", async () => {
    const primary = failingModel(quotaError());
    const hungFallback = { invoke: vi.fn(async () => new Promise<AIMessage>(() => {})) } as unknown as KernelBindableModel;
    const liveFallback = okModel("fallback-1");
    const model = withModelFallbacks(primary, [hungFallback, liveFallback], "kernel", {
      attemptTimeoutMs: 20,
    });

    const reply = await model.invoke(MSGS);

    expect(reply.content).toBe("fallback-1");
    expect(hungFallback.invoke).toHaveBeenCalledTimes(1);
  });

  it("skips remaining fallbacks AND the post-chain primary retry once the budget is exhausted", async () => {
    // Storm conditions: every failing call burns ~100s before its 503 lands.
    let clock = 0;
    const slow503 = (): KernelBindableModel => ({
      invoke: vi.fn(async () => {
        clock += 100_000;
        throw quotaError();
      }),
    });
    const primary = slow503();
    const deadFallback = slow503();
    const neverReached = okModel("never");
    const model = withModelFallbacks(primary, [deadFallback, neverReached], "kernel", {
      now: () => clock,
      budgetMs: 120_000,
      primaryRetryDelayMs: 0,
    });

    await expect(model.invoke(MSGS)).rejects.toThrow();
    expect(deadFallback.invoke).toHaveBeenCalledTimes(1); // 100s elapsed < 120s → still tried
    expect(neverReached.invoke).not.toHaveBeenCalled(); // 200s elapsed ≥ 120s → skipped
    expect(primary.invoke).toHaveBeenCalledTimes(1); // post-chain retry skipped too
  });

  it("REGRESSION 2026-07-17: a full storm of HUNG models fails fast instead of outliving the turn watchdog", async () => {
    // Composed exactly as kernel-boot layers it: fallbacks(retry(primary), [fb]).
    // Before the fix this hung until the 300s watchdog; now it must reject on
    // its own, quickly, with a retriable timeout the caller can classify.
    const hung = (): KernelBindableModel => ({ invoke: vi.fn(() => new Promise(() => {})) }) as unknown as KernelBindableModel;
    const primary = hung();
    const fallback = hung();
    const composed = withModelFallbacks(
      withModelRetry(primary, {
        attemptTimeoutMs: 10,
        budgetMs: 20,
        sleeper: async () => {},
        rng: () => 0.5,
      }),
      [fallback],
      "storm",
      { attemptTimeoutMs: 10, budgetMs: 40, primaryRetryDelayMs: 0 },
    );

    await expect(composed.invoke(MSGS)).rejects.toThrow(/exceeded/);
  });
});
