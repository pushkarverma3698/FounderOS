/**
 * REGRESSION (M2) — getFallbackOffice() no-op path.
 * ====================================================
 * createSupervisor takes a bare model with no middleware option, so the
 * department-level fallback middleware (modelFallbackMiddleware) cannot cover
 * the supervisor's own LLM call — a provider outage on that call previously
 * had no recovery. getFallbackOffice() compiles a SEPARATE office bound to
 * the first configured AGENT_FALLBACK_MODELS entry; office-run.ts retries
 * against it once before giving up.
 *
 * This test only exercises the NO-OP path (no fallback model configured/
 * buildable) — it must return null WITHOUT touching the checkpointer/DB, so
 * it's safe to run with no live Postgres. The configured-and-compiles path is
 * exercised indirectly via office-run.ts's mocked retry test
 * (supervisor-fallback-retry.test.ts) since compiling a real graph needs a
 * real checkpointer.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { getFallbackOffice, __resetOfficeForTests } from "../../../src/agents/office.js";

const SAVED = process.env["AGENT_FALLBACK_MODELS"];

beforeEach(() => {
  __resetOfficeForTests();
});

afterEach(() => {
  __resetOfficeForTests();
  if (SAVED === undefined) delete process.env["AGENT_FALLBACK_MODELS"];
  else process.env["AGENT_FALLBACK_MODELS"] = SAVED;
});

describe("getFallbackOffice — no-op path (M2)", () => {
  it("returns null when AGENT_FALLBACK_MODELS is unset", async () => {
    delete process.env["AGENT_FALLBACK_MODELS"];
    await expect(getFallbackOffice()).resolves.toBeNull();
  });

  it("returns null when every configured fallback is missing its API key", async () => {
    process.env["AGENT_FALLBACK_MODELS"] = "anthropic:claude-haiku-4-5";
    delete process.env["ANTHROPIC_API_KEY"];
    await expect(getFallbackOffice()).resolves.toBeNull();
  });

  it("memoizes the null result — a second call does not re-attempt", async () => {
    delete process.env["AGENT_FALLBACK_MODELS"];
    const first = await getFallbackOffice();
    // Changing the env after the first (memoized) call must NOT change the result —
    // proves the attempt is memoized, matching getOffice()'s own singleton pattern.
    process.env["AGENT_FALLBACK_MODELS"] = "anthropic:claude-haiku-4-5";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const second = await getFallbackOffice();
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
