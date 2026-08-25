/**
 * One-shot worker calls must walk the fallback chain
 * ===================================================
 * `AGENT_FALLBACK_MODELS` has been configured on prod the whole time, and
 * `withModelFallbacks` makes the KERNEL use it. But `tailorCv` and
 * `buildCoverLetter` reach for `getWorkerModel()` and call `.invoke` on it
 * directly — the bare primary, no chain.
 *
 * Measured on prod 2026-08-21, minutes after the apply packet shipped: every
 * tailoring attempt died on `gemini-flash-latest` 503, while
 * `gemini-3.1-flash-lite` and `gemini-3-flash-preview` both answered "ok" on the
 * same key, in the same second. Two working models sat one line of code away
 * from an application that could not be written.
 *
 * This is the 2026-07-11 incident recurring one layer down — fallbacks armed,
 * chain never engaged, founder gets the error. The engagement rule is the same
 * `isModelFallbackError`: 5xx/429/transport/404-retired retry, and 401/403 fail
 * LOUD so a bad key never burns the chain and hides itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const primary = vi.fn();
const fallbackA = vi.fn();
const fallbackB = vi.fn();

vi.mock("../../../src/agents/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agents/model.js")>();
  return {
    ...actual,
    getWorkerModel: () => ({ invoke: primary }),
    buildFallbackModels: () => [{ invoke: fallbackA }, { invoke: fallbackB }],
  };
});

async function invoke() {
  const { invokeWorkerWithFallbacks } = await import("../../../src/agents/worker-invoke.js");
  return invokeWorkerWithFallbacks([{ role: "user", content: "hi" }]);
}

/** Shaped like the real provider errors `httpStatusOf` reads. */
function providerError(status: number): Error {
  const err = new Error(`[GoogleGenerativeAI Error]: [${status} Service Unavailable] high demand`);
  (err as Error & { status?: number }).status = status;
  return err;
}

beforeEach(() => {
  vi.resetModules();
  primary.mockReset();
  fallbackA.mockReset();
  fallbackB.mockReset();
});

describe("invokeWorkerWithFallbacks", () => {
  it("uses the primary and never touches the chain when it answers", async () => {
    primary.mockResolvedValue({ content: "from primary" });

    const res = await invoke();
    expect(res.content).toBe("from primary");
    expect(fallbackA).not.toHaveBeenCalled();
    expect(fallbackB).not.toHaveBeenCalled();
  });

  // THE PROD CASE, 2026-08-21: primary 503, first fallback fine.
  it("falls through to the chain on a 503", async () => {
    primary.mockRejectedValue(providerError(503));
    fallbackA.mockResolvedValue({ content: "from flash-lite" });

    const res = await invoke();
    expect(res.content).toBe("from flash-lite");
    expect(fallbackB).not.toHaveBeenCalled();
  });

  it("keeps walking when a fallback also fails", async () => {
    primary.mockRejectedValue(providerError(503));
    fallbackA.mockRejectedValue(providerError(429));
    fallbackB.mockResolvedValue({ content: "from the last one" });

    const res = await invoke();
    expect(res.content).toBe("from the last one");
  });

  // 401/403 share no key with the chain, so falling through would turn a
  // misconfiguration into a silent, slower success on a different model — and
  // hide the fact that the primary key is dead (audit Run B).
  it("fails LOUD on an auth error without burning the chain", async () => {
    primary.mockRejectedValue(providerError(401));

    await expect(invoke()).rejects.toThrow(/401/);
    expect(fallbackA).not.toHaveBeenCalled();
    expect(fallbackB).not.toHaveBeenCalled();
  });

  // When everything is genuinely down the caller must see the PRIMARY's error,
  // not the last fallback's. "llama-3.3-70b is unavailable for free" sends the
  // reader to the wrong provider; "gemini-flash-latest 503" is the real cause.
  it("reports the primary's failure when the whole chain is down", async () => {
    primary.mockRejectedValue(providerError(503));
    fallbackA.mockRejectedValue(new Error("404 unavailable for free"));
    fallbackB.mockRejectedValue(new Error("404 unavailable for free"));

    await expect(invoke()).rejects.toThrow(/503/);
  });

  // A provider that HANGS is not a provider that errors, and the first version
  // of this module only handled the second. Prod 2026-08-21: a live tailor_cv
  // run sat in `model.invoke` for the full 280s timeout and never reached the
  // chain — the exact reason gateway/model-fallback.ts carries a deadline.
  it("treats a hanging attempt as a failure and moves on", async () => {
    primary.mockImplementation(() => new Promise(() => undefined));
    fallbackA.mockResolvedValue({ content: "from flash-lite" });

    const { invokeWorkerWithFallbacks } = await import("../../../src/agents/worker-invoke.js");
    const res = await invokeWorkerWithFallbacks([{ role: "user", content: "hi" }], {
      attemptTimeoutMs: 40,
    });

    expect(res.content).toBe("from flash-lite");
  });

  it("times out a hanging fallback too, rather than stalling the chain", async () => {
    primary.mockRejectedValue(providerError(503));
    fallbackA.mockImplementation(() => new Promise(() => undefined));
    fallbackB.mockResolvedValue({ content: "from the last one" });

    const { invokeWorkerWithFallbacks } = await import("../../../src/agents/worker-invoke.js");
    const res = await invokeWorkerWithFallbacks([{ role: "user", content: "hi" }], {
      attemptTimeoutMs: 40,
    });

    expect(res.content).toBe("from the last one");
  });

  // T1c, 2026-08-25: tailorCv and buildCoverLetter both call this function
  // with NEITHER callbacks NOR metadata attached, so every tailoring call was
  // invisible to ai_call_costs and therefore to the daily budget cap — even
  // though the kernel's own graph has attached BudgetGuardCallback since the
  // beginning. This is the wiring that closes that gap. (BudgetGuardCallback's
  // own cost math already has dedicated coverage in
  // tests/unit/infra/budget.test.ts — these tests are about the wiring, not
  // re-proving that arithmetic.)
  //
  // Placed BEFORE "propagates the primary error when no fallbacks are
  // configured", deliberately: that test's `vi.doMock(...buildFallbackModels:
  // () => [])` outlives `beforeEach`'s `vi.resetModules()` for whatever runs
  // after it in the same file, so a fallback-path test placed later would
  // silently see an empty fallback chain and fail on an unrelated cause.
  describe("cost attribution", () => {
    it("passes no cost config to invoke when no attribution is given", async () => {
      primary.mockResolvedValue({ content: "ok" });
      await invoke();
      expect(primary.mock.calls[0]?.[1]).toBeUndefined();
    });

    it("attaches cost metadata and a budget callback when attribution is given", async () => {
      const { invokeWorkerWithFallbacks } = await import("../../../src/agents/worker-invoke.js");
      const { BudgetGuardCallback } = await import("../../../src/infra/budget.js");
      primary.mockResolvedValue({ content: "ok" });

      await invokeWorkerWithFallbacks([{ role: "user", content: "hi" }], {
        attribution: { agent: "jobhunt", stage: "worker" },
      });

      const config = primary.mock.calls[0]?.[1] as { metadata?: Record<string, string>; callbacks?: unknown[] };
      expect(config.metadata).toEqual({ cost_agent: "jobhunt", cost_stage: "worker" });
      expect(config.callbacks).toHaveLength(1);
      expect(config.callbacks?.[0]).toBeInstanceOf(BudgetGuardCallback);
    });

    it("carries the same cost config through to a fallback attempt", async () => {
      const { invokeWorkerWithFallbacks } = await import("../../../src/agents/worker-invoke.js");
      primary.mockRejectedValue(providerError(503));
      fallbackA.mockResolvedValue({ content: "from flash-lite" });

      await invokeWorkerWithFallbacks([{ role: "user", content: "hi" }], {
        attribution: { agent: "jobhunt", stage: "worker" },
      });

      const config = fallbackA.mock.calls[0]?.[1] as { metadata?: Record<string, string> };
      expect(config.metadata).toEqual({ cost_agent: "jobhunt", cost_stage: "worker" });
    });
  });

  it("propagates the primary error when no fallbacks are configured", async () => {
    vi.doMock("../../../src/agents/model.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../src/agents/model.js")>();
      return { ...actual, getWorkerModel: () => ({ invoke: primary }), buildFallbackModels: () => [] };
    });
    primary.mockRejectedValue(providerError(503));

    await expect(invoke()).rejects.toThrow(/503/);
  });
});
