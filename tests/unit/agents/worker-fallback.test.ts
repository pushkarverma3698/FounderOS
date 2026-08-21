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

  it("propagates the primary error when no fallbacks are configured", async () => {
    vi.doMock("../../../src/agents/model.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../src/agents/model.js")>();
      return { ...actual, getWorkerModel: () => ({ invoke: primary }), buildFallbackModels: () => [] };
    });
    primary.mockRejectedValue(providerError(503));

    await expect(invoke()).rejects.toThrow(/503/);
  });
});
