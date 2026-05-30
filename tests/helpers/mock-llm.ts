/**
 * Mock LLM helpers for unit + integration tests.
 *
 * Usage: import { makeMockCascade, makeFailingCascade } from "./mock-llm.js"
 *
 * Design:
 *   - makeMockCascade: returns a vi.fn() that resolves to a fixed CascadeResult.
 *     Use when you want the LLM to succeed and return predictable text.
 *   - makeFailingCascade: returns a vi.fn() that rejects with AggregateError.
 *     Use for P4-HARD-1 chaos tests (all providers fail scenario).
 *   - makeCascadeSequence: returns a vi.fn() that uses mockResolvedValueOnce
 *     for a sequence of responses.
 *   - Never mocks fetch directly — mocks callCascade at the module boundary.
 *     This tests pod node behaviour without touching HTTP.
 */

import { vi } from "vitest";
import type { CascadeResult } from "../../src/infra/llm.js";
import type { CascadeTier } from "../../src/core/registry.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_RESULT: CascadeResult = {
  text: '{"status":"ok"}',
  model: "mock-model",
  provider: "google",
  tier: "md" as CascadeTier,
  tokensIn: 10,
  tokensOut: 20,
  costUsd: 0,
};

// ── Factory Functions ─────────────────────────────────────────────────────────

/**
 * Returns a vi.fn() that resolves to a fixed CascadeResult.
 * Useful for happy-path tests where LLM output doesn't matter.
 *
 * @param overrides  Partial CascadeResult to merge with defaults
 */
export function makeMockCascade(overrides: Partial<CascadeResult> = {}) {
  return vi.fn().mockResolvedValue({ ...DEFAULT_RESULT, ...overrides });
}

/**
 * Returns a vi.fn() that always rejects with an AggregateError.
 * Simulates all cascade providers failing (P4-HARD-1 chaos scenario).
 */
export function makeFailingCascade() {
  return vi.fn().mockRejectedValue(
    new AggregateError(
      [
        new Error("anthropic:claude-sonnet-4-5: HTTP 503"),
        new Error("google:gemini-2.5-flash: HTTP 429"),
        new Error("openrouter:llama-3.3-70b: circuit breaker open"),
      ],
      'All cascade entries for tier "md" failed',
    ),
  );
}

/**
 * Returns a vi.fn() that resolves to each result in the sequence in order.
 * When exhausted, resolves to the last result (or rejects if last was an error).
 *
 * @param responses  Array of CascadeResult overrides (in call order)
 */
export function makeCascadeSequence(responses: Array<Partial<CascadeResult>>) {
  const mock = vi.fn();
  for (const r of responses) {
    mock.mockResolvedValueOnce({ ...DEFAULT_RESULT, ...r });
  }
  return mock;
}

/**
 * Returns a vi.fn() that returns NEEDS_REVISION for the first N calls,
 * then APPROVED. Used to test the critic revision loop.
 *
 * The text contains the JSON the critic node expects.
 */
export function makeCriticSequence(needsRevisionCount: number) {
  const mock = vi.fn();
  for (let i = 0; i < needsRevisionCount; i++) {
    mock.mockResolvedValueOnce({
      ...DEFAULT_RESULT,
      text: JSON.stringify({
        result: "NEEDS_REVISION",
        notes: `Revision ${i + 1}: improve specificity`,
        rule_violations: ["too generic"],
        critic_model: "claude-haiku-4-5",
      }),
    });
  }
  mock.mockResolvedValue({
    ...DEFAULT_RESULT,
    text: JSON.stringify({
      result: "APPROVED",
      notes: "Email looks good",
      rule_violations: [],
      critic_model: "claude-haiku-4-5",
    }),
  });
  return mock;
}
