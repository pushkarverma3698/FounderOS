/**
 * The synthesizer may report an absence. It may not explain one.
 *
 * THE INCIDENT (2026-09-16 19:47, production). The founder asked "Why is it that
 * it haven't worked on a branch?" about a dispatched Antigravity task. FounderOS
 * replied:
 *
 *   "Antigravity has not yet created a branch or PR because it is currently
 *    actively executing the implementation, test suite, and verification pipeline
 *    in its isolated workspace."
 *
 * Nothing observed that. No tool in the catalog can see an Antigravity workspace;
 * the step results held an issue state and the absence of a branch and a PR. The
 * reassuring mechanism was invented whole. Six minutes later, asked again, the
 * same system reported "Branch spawned: No. Work completed: No. Pull request
 * opened: No."
 *
 * This is the most expensive hallucination class for a product the founder is
 * meant to run his day on, because it is unfalsifiable and it counsels patience:
 * a fabricated "it's working on it" costs him the hours he waits. The existing
 * prompt forbids inventing URLs — a fact-shaped claim — and says nothing about
 * inventing causes, which is the shape that actually shipped.
 *
 * The rule: absence of evidence is reported as absence. A cause appears in the
 * reply only when a step result states it.
 */

import { describe, expect, it } from "vitest";
import { SYNTHESIZER_PROMPT } from "../../../src/kernel/synthesizer.js";

describe("SYNTHESIZER_PROMPT — no invented causes", () => {
  it("forbids explaining WHY something did not happen without a result that says so", () => {
    expect(SYNTHESIZER_PROMPT).toMatch(/never (?:explain|invent|guess).*(?:why|reason|cause)/i);
  });

  it("names the absence-of-evidence rule explicitly", () => {
    expect(SYNTHESIZER_PROMPT).toMatch(/absence of evidence/i);
  });

  it("forbids the specific 'still in progress / working on it' reassurance", () => {
    expect(SYNTHESIZER_PROMPT).toMatch(/in progress|still working|underway/i);
  });

  it("keeps the rules that already held: no invented URLs, no false completion", () => {
    expect(SYNTHESIZER_PROMPT).toMatch(/NEVER fabricate, invent, or guess URLs/);
    expect(SYNTHESIZER_PROMPT).toMatch(/Mission complete/);
    expect(SYNTHESIZER_PROMPT).toMatch(/ONLY the step results/);
  });

  it("tells the model what to say instead, so the rule is actionable", () => {
    expect(SYNTHESIZER_PROMPT).toMatch(/did not (?:observe|report)|no result|nothing observed/i);
  });
});
