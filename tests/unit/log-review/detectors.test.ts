// tests/unit/log-review/detectors.test.ts
import { describe, it, expect } from "vitest";
import { runDetectors } from "../../../scripts/log-review/detectors.js";
import type { Turn } from "../../../scripts/log-review/types.js";

const base = (o: Partial<Turn>): Turn => ({
  turnId: "T",
  startMs: 0,
  endMs: 1,
  lines: [],
  toolErrors: 0,
  hadError: false,
  ...o,
});

describe("runDetectors", () => {
  it("flags an errored turn", () => {
    const a = runDetectors([
      base({ hadError: true, lines: [{ level: 50, time: 1, msg: "crash", raw: "crash" }] }),
    ]);
    expect(a.some((x) => x.type === "error")).toBe(true);
  });

  it("flags a wedge/recursion abort", () => {
    const a = runDetectors([
      base({ lines: [{ level: 40, time: 1, seam: "wedge.recovered", raw: "wedge", msg: "recursion limit" }] }),
    ]);
    expect(a.some((x) => x.type === "wedge")).toBe(true);
  });

  it("flags latency spike over threshold", () => {
    const a = runDetectors([base({ durationMs: 45000 })]);
    expect(a.some((x) => x.type === "latency_cost")).toBe(true);
  });

  it("does NOT flag an honest refusal as a problem (P0-2)", () => {
    const a = runDetectors([
      base({ reply: "Sorry, I don't have that information.", durationMs: 800 }),
    ]);
    // an honest refusal alone is healthy — no hard anomaly
    expect(a.filter((x) => x.severity === "high")).toHaveLength(0);
  });

  it("routes a confident-no-tool-call turn into the borderline set", () => {
    const a = runDetectors([
      base({
        reply: "Turicks targets B2B SaaS founders in seed stage.",
        lines: [{ level: 30, time: 1, seam: "route.decided", raw: "route", data: { dept: "research" } }],
        // no tool.result / no rag hit in lines
      }),
    ]);
    expect(a.some((x) => x.type === "hallucination_candidate")).toBe(true);
  });

  it("returns nothing for a clean turn with a tool call", () => {
    const a = runDetectors([
      base({
        reply: "Found 3 results.",
        durationMs: 900,
        lines: [{ level: 30, time: 1, seam: "tool.result", raw: "ok" }],
      }),
    ]);
    expect(a).toHaveLength(0);
  });
});

describe("hallucination_candidate — refusal phrasings (honest refusals NEVER flagged)", () => {
  // These must NEVER appear as hallucination_candidate — rule #1 of stage3-prompt.md
  const HONEST_REFUSALS = [
    "I don't have access to that information.",
    "I do not have details about Turicks' pricing.",
    "I cannot answer that without more context.",
    "I can't find any information about this.",
    "I have no information about that topic.",
    "I'm not able to provide that.",
    "Sorry, I don't know the answer to this.",
  ];

  HONEST_REFUSALS.forEach((reply) => {
    it(`does not flag refusal: "${reply.slice(0, 50)}..."`, () => {
      const a = runDetectors([base({ reply })]);
      expect(a.some((x) => x.type === "hallucination_candidate")).toBe(false);
    });
  });

  it("DOES flag a confident substantive reply with no grounding (true hallucination candidate)", () => {
    const a = runDetectors([
      base({
        reply: "Turicks closed a £200k ARR deal with Acme Corp last quarter via the outbound workflow.",
        lines: [{ level: 30, time: 1, seam: "turn.in", raw: "turn.in" }],
      }),
    ]);
    expect(a.some((x) => x.type === "hallucination_candidate")).toBe(true);
  });

  it("does not flag a grounded confident reply (has tool.result seam)", () => {
    const a = runDetectors([
      base({
        reply: "Based on the search results, Turicks targets seed-stage B2B SaaS founders.",
        lines: [
          { level: 30, time: 1, seam: "tool.result", raw: "tool result" },
          { level: 30, time: 2, seam: "turn.out", raw: "turn.out" },
        ],
      }),
    ]);
    expect(a.some((x) => x.type === "hallucination_candidate")).toBe(false);
  });

  it("does not flag a reply grounded by search_knowledge in logs", () => {
    const a = runDetectors([
      base({
        reply: "According to our knowledge base, Turicks provides done-for-you cinematic brand content.",
        lines: [{ level: 30, time: 1, seam: "llm.call", raw: "search_knowledge tool called" }],
      }),
    ]);
    expect(a.some((x) => x.type === "hallucination_candidate")).toBe(false);
  });

  it("does not flag a reply that is too short to be substantive (<40 chars)", () => {
    const a = runDetectors([base({ reply: "Yes, I can help with that!" })]);
    expect(a.some((x) => x.type === "hallucination_candidate")).toBe(false);
  });
});
