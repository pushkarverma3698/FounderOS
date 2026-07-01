/**
 * applyGuardOutcome — retry-symmetry fix (2026-06-30).
 *
 * needsExecutionGuardRetry() detects 7 "model skipped its gated tool" shapes.
 * office-run.ts retries ONCE per turn. Before this fix, only "knowledge" and
 * "memory" were re-verified after that retry — if the SAME guard fired again
 * for shell/linkedin/inbox/github/web, the still-broken reply was sent to the
 * founder silently (no block, no notice, no trace event). That asymmetry is
 * exactly how a "fixed" refusal/loop bug (HARD-1, HARD-2, T02, T04, B1, B5)
 * could resurface under a new phrasing without any test catching it: the
 * retry ran, but nothing checked whether it actually worked.
 *
 * This proves all 7 kinds now terminate the same way: pass-through only when
 * the guard is fully clear, otherwise an honest message — never silent.
 */

import { describe, it, expect } from "vitest";
import { applyGuardOutcome } from "../../../src/gateway/office-run.js";
import type { GuardKind } from "../../../src/gateway/execution-guard.js";

describe("applyGuardOutcome", () => {
  it("passes the reply through unchanged when the guard is clear (null)", () => {
    const result = applyGuardOutcome(null, "Here are your 3 open GitHub issues: ...");
    expect(result).toEqual({ replyText: "Here are your 3 open GitHub issues: ...", blocked: false });
  });

  it("replaces the reply with the fabrication-safe refusal for 'knowledge'", () => {
    const result = applyGuardOutcome("knowledge", "Turicks' ICP is SMEs with $500K ARR.");
    expect(result.blocked).toBe(true);
    expect(result.replyText).toMatch(/turicks-brain/i);
    expect(result.replyText).not.toContain("$500K");
  });

  it("replaces the reply with the fabrication-safe refusal for 'memory'", () => {
    const result = applyGuardOutcome("memory", "We decided to raise prices to $10K.");
    expect(result.blocked).toBe(true);
    expect(result.replyText).toMatch(/turicks-brain/i);
  });

  // The 5 kinds that previously had NO post-retry fallback at all.
  const previouslyUnhandled: GuardKind[] = ["shell", "linkedin", "inbox", "github", "web"];

  it.each(previouslyUnhandled)(
    "blocks and returns an honest exhaustion notice for '%s' instead of the still-broken reply",
    (kind) => {
      const stillBrokenReply = "I cannot help with that right now.";
      const result = applyGuardOutcome(kind, stillBrokenReply);
      expect(result.blocked).toBe(true);
      // The original (still-broken) reply must NOT reach the founder unchanged.
      expect(result.replyText).not.toBe(stillBrokenReply);
      expect(result.replyText).toMatch(/tried twice/i);
    },
  );

  it("never fabricates a success claim in any exhaustion notice", () => {
    const allBlockedKinds: GuardKind[] = ["shell", "linkedin", "inbox", "github", "web", "knowledge", "memory"];
    for (const kind of allBlockedKinds) {
      const { replyText } = applyGuardOutcome(kind, "irrelevant original reply");
      expect(replyText).not.toMatch(/✅|done|created|sent|posted/i);
    }
  });
});
