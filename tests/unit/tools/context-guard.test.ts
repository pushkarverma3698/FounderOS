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
import {
  CONTEXT_FOCUS_MAX_CHARS,
  CONTEXT_PROJECTS_MAX_ITEMS,
  CONTEXT_PROJECT_MAX_CHARS,
  sanitizeContextUpdates,
} from "../../../src/tools/context-guard.js";

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

// current_focus / active_projects: the two keys /focus and /projects write. They
// were not recognised at all, so update_context rejected every attempt to correct
// June's values. Both are bounded, and an over-limit value is refused with the
// limit named, never silently cut.
describe("sanitizeContextUpdates — current_focus and active_projects", () => {
  it("passes a focus, trimmed and on one line", () => {
    const { clean, rejected } = sanitizeContextUpdates({ current_focus: "  Close the Acme pilot\n  and ship the proof page  " });
    expect(clean["current_focus"]).toBe("Close the Acme pilot and ship the proof page");
    expect(rejected).toEqual([]);
  });

  it("does not apply the advisory filter to the founder's own focus: 'should' and 'might' are his words", () => {
    const text = "Finish the Acme proposal; the second demo might slip, so it should go out first";
    const { clean, rejected } = sanitizeContextUpdates({ current_focus: text });
    expect(clean["current_focus"]).toBe(text);
    expect(rejected).toEqual([]);
  });

  it("keeps the advisory filter on notes", () => {
    expect(sanitizeContextUpdates({ notes: "You should consider hiring" }).clean["notes"]).toBeUndefined();
  });

  it("accepts a focus of exactly the limit and rejects one character more, naming both numbers", () => {
    expect(sanitizeContextUpdates({ current_focus: "x".repeat(CONTEXT_FOCUS_MAX_CHARS) }).rejected).toEqual([]);
    const { clean, rejected } = sanitizeContextUpdates({ current_focus: "x".repeat(CONTEXT_FOCUS_MAX_CHARS + 1) });
    expect(clean["current_focus"]).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.key).toBe("current_focus");
    expect(rejected[0]!.reason).toContain(String(CONTEXT_FOCUS_MAX_CHARS + 1));
    expect(rejected[0]!.reason).toContain(String(CONTEXT_FOCUS_MAX_CHARS));
  });

  it("measures the focus after trimming, so padding does not count against it", () => {
    const padded = `   ${"x".repeat(CONTEXT_FOCUS_MAX_CHARS)}   `;
    expect(sanitizeContextUpdates({ current_focus: padded }).rejected).toEqual([]);
  });

  it("rejects an empty, whitespace-only or non-string focus", () => {
    for (const bad of ["", "   ", "\n\t", 7, ["a"], null]) {
      const { clean, rejected } = sanitizeContextUpdates({ current_focus: bad });
      expect(clean["current_focus"], String(bad)).toBeUndefined();
      expect(rejected, String(bad)).toHaveLength(1);
    }
  });

  it("passes projects, trimmed, on one line each, empties dropped", () => {
    const { clean, rejected } = sanitizeContextUpdates({ active_projects: ["  FounderOS ", "", "Naggar\nsite"] });
    expect(clean["active_projects"]).toEqual(["FounderOS", "Naggar site"]);
    expect(rejected).toEqual([]);
  });

  it("accepts the most projects allowed and rejects one more, naming both numbers", () => {
    const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `Project ${i + 1}`);
    expect(sanitizeContextUpdates({ active_projects: items(CONTEXT_PROJECTS_MAX_ITEMS) }).rejected).toEqual([]);
    const { clean, rejected } = sanitizeContextUpdates({ active_projects: items(CONTEXT_PROJECTS_MAX_ITEMS + 1) });
    expect(clean["active_projects"]).toBeUndefined();
    expect(rejected[0]!.reason).toContain(String(CONTEXT_PROJECTS_MAX_ITEMS + 1));
    expect(rejected[0]!.reason).toContain(String(CONTEXT_PROJECTS_MAX_ITEMS));
  });

  it("names which project is too long and the limit", () => {
    const { clean, rejected } = sanitizeContextUpdates({
      active_projects: ["Short", "y".repeat(CONTEXT_PROJECT_MAX_CHARS + 1)],
    });
    expect(clean["active_projects"]).toBeUndefined();
    expect(rejected[0]!.reason).toContain("entry 2 "); // the second one, not the first
    expect(rejected[0]!.reason).toContain(String(CONTEXT_PROJECT_MAX_CHARS + 1));
    expect(rejected[0]!.reason).toContain(String(CONTEXT_PROJECT_MAX_CHARS));
  });

  it("rejects projects that are not an array of strings", () => {
    const { clean, rejected } = sanitizeContextUpdates({ active_projects: "FounderOS; Naggar" });
    expect(clean["active_projects"]).toBeUndefined();
    expect(rejected[0]!.reason).toContain("array");
  });

  it("leaves the limits on the older keys where they were: none", () => {
    const long = "z".repeat(CONTEXT_PROJECT_MAX_CHARS * 5);
    expect(sanitizeContextUpdates({ active_clients: [long] }).clean["active_clients"]).toEqual([long]);
  });
});
