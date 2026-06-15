/**
 * Unit tests for sanitizeContextUpdates — the deterministic write-validation
 * guard for `update_context` (founder_context).
 *
 * Why this exists: prod hallucination root-caused 2026-06-15 to a junk note
 * ("A setup combining GBrain, MemSearch … would be highly effective …") that the
 * model wrote into founder_context.notes via update_context, after which
 * read_context surfaced it on every turn as authoritative "Current business
 * context". The schema was z.record(z.unknown()) — it accepted anything.
 *
 * The guard (pure, rule #16) enforces: only recognised keys, correct types, and
 * notes must record factual STATE — advisory/speculative recommendations are
 * rejected (that is what the junk note was).
 *
 * Key scenarios:
 *  1. Valid structured arrays pass through, trimmed + empties dropped
 *  2. Valid factual note passes
 *  3. The exact prod junk note is rejected (advisory)
 *  4. Advisory markers each rejected (would be / could be / recommend / etc.)
 *  5. Unrecognised keys rejected (not silently persisted)
 *  6. Wrong types rejected (array key given string, string key given array)
 *  7. Empty / whitespace-only note rejected
 *  8. Mixed input: clean keys kept, junk keys reported in `rejected`
 *  9. Never throws on garbage input (deterministic, fail-safe)
 */

import { describe, it, expect } from "vitest";
import { sanitizeContextUpdates } from "../../../src/tools/context-guard.js";

describe("sanitizeContextUpdates", () => {
  it("passes valid structured arrays, trimming and dropping empties", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      active_clients: ["  Acme  ", "", "Beta Ltd"],
      current_priorities: ["Close Acme deal"],
    });
    expect(clean["active_clients"]).toEqual(["Acme", "Beta Ltd"]);
    expect(clean["current_priorities"]).toEqual(["Close Acme deal"]);
    expect(rejected).toHaveLength(0);
  });

  it("passes a factual note", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      notes: "Acme signed the SOW on 2026-06-10; kickoff Monday.",
    });
    expect(clean["notes"]).toBe("Acme signed the SOW on 2026-06-10; kickoff Monday.");
    expect(rejected).toHaveLength(0);
  });

  it("rejects the exact prod junk note (advisory/speculative)", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      notes:
        "A setup combining GBrain, MemSearch for Claude code, and FounderOS would be highly effective for enhanced AI agent memory and streamlined founder operations.",
    });
    expect(clean["notes"]).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.key).toBe("notes");
  });

  it("rejects each advisory marker", () => {
    const advisory = [
      "We could be more effective with X",
      "You should consider hiring",
      "I recommend pivoting to SaaS",
      "It would help to add caching",
      "This might improve retention",
    ];
    for (const note of advisory) {
      const { clean } = sanitizeContextUpdates({ notes: note });
      expect(clean["notes"], `should reject: ${note}`).toBeUndefined();
    }
  });

  it("rejects unrecognised keys instead of persisting them", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      secret_plan: "delete prod",
      random: 42,
    });
    expect(Object.keys(clean)).toHaveLength(0);
    expect(rejected.map((r) => r.key).sort()).toEqual(["random", "secret_plan"]);
  });

  it("rejects wrong types for recognised keys", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      active_clients: "Acme", // should be array
      notes: ["a", "b"], // should be string
    });
    expect(Object.keys(clean)).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });

  it("rejects empty / whitespace-only notes", () => {
    expect(sanitizeContextUpdates({ notes: "   " }).clean["notes"]).toBeUndefined();
    expect(sanitizeContextUpdates({ notes: "" }).clean["notes"]).toBeUndefined();
  });

  it("keeps clean keys and reports junk in a mixed payload", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      active_clients: ["Acme"],
      notes: "X would be highly effective", // advisory → rejected
      bogus: true, // unknown → rejected
    });
    expect(clean["active_clients"]).toEqual(["Acme"]);
    expect(clean["notes"]).toBeUndefined();
    expect(rejected.map((r) => r.key).sort()).toEqual(["bogus", "notes"]);
  });

  it("never throws on garbage input", () => {
    expect(() => sanitizeContextUpdates({} as Record<string, unknown>)).not.toThrow();
    // @ts-expect-error — deliberately bad runtime input
    expect(() => sanitizeContextUpdates(null)).not.toThrow();
    // @ts-expect-error — deliberately bad runtime input
    expect(() => sanitizeContextUpdates(undefined)).not.toThrow();
  });
});
