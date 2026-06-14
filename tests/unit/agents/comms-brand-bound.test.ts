/**
 * Regression test for the brand-validator infinite retry loop (P1).
 * ==================================================================
 * SYMPTOM: on a LinkedIn post that hovers near the 150-word boundary, the model
 * oscillated (146 → 113 → 146 …) and the linkedin_post tool re-rejected forever,
 * re-calling until OFFICE_RECURSION_LIMIT → GraphRecursionError.
 *
 * The fix bounds brand-validation retries: after BRAND_MAX_RETRIES failures the
 * tool STOPS re-drafting and instead proceeds to the HITL gate with the closest
 * draft (violations noted). This test drives the REAL linkedin_post tool with an
 * always-too-short draft and proves it reaches the gate in ≤ BRAND_MAX_RETRIES+1
 * calls — never an unbounded loop.
 *
 * interrupt() and the Composio send are mocked so we exercise the bounding logic,
 * not the network (the note in the task: the real send 401s on an invalid key —
 * irrelevant here; we test that the validator loop terminates).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (hoisted before dynamic import) ────────────────────────────────────

const mockInterrupt = vi.fn();
vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: mockInterrupt };
});

const mockExecute = vi.fn();
vi.mock("../../../src/tools/linkedin.js", () => ({
  linkedinPostTool: { execute: (...a: unknown[]) => mockExecute(...a) },
}));

const { linkedinPost } = await import("../../../src/agents/agent-tools/comms.js");
const { BRAND_MAX_RETRIES } = await import("../../../src/infra/brand-retry.js");
const { _resetBrandRetries } = await import("../../../src/infra/brand-retry.js");

// An always-invalid draft: valid hook (has a number) but far under 150 words, so
// it fails brand validation on every single call — the worst-case oscillation.
const TOO_SHORT = "3 founders asked me this today.\n\nShort post body, nowhere near 150 words.";

function callWithThread(thread: string) {
  return linkedinPost.invoke({ text: TOO_SHORT }, { configurable: { thread_id: thread } });
}

describe("linkedin_post brand-retry bounding", () => {
  // Pin gate 2 (Claude judge) to its no-op fail-open mode so this brand-bounding
  // regression never makes a live Claude call. Judge behaviour is covered in
  // judge.test.ts; here we only assert the deterministic brand loop terminates.
  let savedKey: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    _resetBrandRetries();
    savedKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    mockInterrupt.mockReturnValue("approved");
    mockExecute.mockResolvedValue({ success: true, data: {} });
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
  });

  it("returns fix guidance (no gate) for the first BRAND_MAX_RETRIES failures", async () => {
    for (let i = 0; i < BRAND_MAX_RETRIES; i++) {
      const out = await callWithThread("thread-A");
      expect(out).toMatch(/Revise before posting/);
      // exact-delta guidance, not the raw "word count too low"
      expect(out).toMatch(/Add at least \d+ more words/);
    }
    // No HITL gate reached yet — still asking the agent to re-draft.
    expect(mockInterrupt).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("STOPS looping and reaches the HITL gate on the (cap+1)th failure", async () => {
    let lastOut = "";
    for (let i = 0; i <= BRAND_MAX_RETRIES; i++) {
      lastOut = (await callWithThread("thread-B")) as string;
    }
    // The capped call did NOT return another fix message — it gated + sent.
    expect(lastOut).not.toMatch(/Revise before posting/);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
    // The HITL card carries the brand warning so the founder is informed.
    const payload = mockInterrupt.mock.calls[0]?.[0] as { summary: string };
    expect(payload.summary).toMatch(/after \d+ fix attempts/);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("terminates within BRAND_MAX_RETRIES+1 calls even if the model never converges", async () => {
    let gateReached = false;
    for (let i = 0; i < 50; i++) {
      const out = (await callWithThread("thread-C")) as string;
      if (!/Revise before posting/.test(out)) {
        gateReached = true;
        expect(i).toBe(BRAND_MAX_RETRIES); // 0-indexed → the (cap+1)th call
        break;
      }
    }
    expect(gateReached).toBe(true);
  });

  it("keeps counts separate per thread (one task's loop doesn't trip another)", async () => {
    // Exhaust the cap on thread-D.
    for (let i = 0; i <= BRAND_MAX_RETRIES; i++) await callWithThread("thread-D");
    vi.clearAllMocks();
    mockInterrupt.mockReturnValue("approved");
    mockExecute.mockResolvedValue({ success: true, data: {} });
    // A fresh thread starts its own count — first call is still a fix message.
    const out = await callWithThread("thread-E");
    expect(out).toMatch(/Revise before posting/);
    expect(mockInterrupt).not.toHaveBeenCalled();
  });
});
