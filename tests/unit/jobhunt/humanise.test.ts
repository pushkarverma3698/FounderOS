/**
 * AI-tell detector tests.
 *
 * Every cover letter and post this machine drafts is written by an LLM. In 2026 a
 * recruiter who spots LLM prose discards the application — so a draft that reads
 * as generated is worse than no draft at all.
 *
 * The detector is DETERMINISTIC on purpose: asking an LLM "does this sound like
 * an LLM?" is the same self-assessment failure the kernel refuses everywhere else.
 * Same reasoning as the benchmark scorer — the grader must not be able to
 * hallucinate.
 */

import { describe, it, expect } from "vitest";
import {
  detectAiTells,
  aiTellScore,
  needsHumanising,
  TELL_THRESHOLD,
} from "../../../src/tools/jobhunt/humanise.js";

const humanCoverLetter = `
I read your posting for the agent infrastructure role. I run a LangGraph system in
production that takes real actions behind human approval, and the part I got wrong
twice was approval ordering: I was writing the audit row before the send actually
succeeded, so a failed send still looked like a completed one. I fixed it by writing
the approval row before interrupt() fires and checking the idempotency key before
every external call. I would like to work on this problem with other people.
`;

const generatedCoverLetter = `
I am thrilled to share my excitement for this pivotal opportunity! In today's
fast-paced AI landscape, I have leveraged cutting-edge technologies to deliver
robust, scalable, and seamless solutions. My journey has been a testament to my
meticulous approach. This isn't just about writing code, it's about unlocking
transformative value. I would love to delve deeper into how I can elevate your team.
At the end of the day, I am confident I would be a game-changer.
`;

describe("detectAiTells", () => {
  it("finds nothing objectionable in specific, concrete human prose", () => {
    expect(detectAiTells(humanCoverLetter)).toHaveLength(0);
  });

  it("flags the standard LLM vocabulary", () => {
    const kinds = detectAiTells(generatedCoverLetter).map((t) => t.tell);
    expect(kinds).toContain("delve");
    expect(kinds).toContain("leverage");
    expect(kinds).toContain("cutting-edge");
    expect(kinds).toContain("testament");
  });

  it("flags the 'excited to share' opener", () => {
    const tells = detectAiTells("I am thrilled to share my latest project!");
    expect(tells.some((t) => t.category === "opener")).toBe(true);
  });

  it("flags the 'not just X, it's Y' construction", () => {
    const tells = detectAiTells("This isn't just a refactor, it's a rethink.");
    expect(tells.some((t) => t.category === "construction")).toBe(true);
  });

  it("flags summary closers", () => {
    const tells = detectAiTells("At the end of the day, the bottom line is clear.");
    expect(tells.some((t) => t.category === "closer")).toBe(true);
  });

  it("reports where each tell occurred so a human can fix it", () => {
    for (const tell of detectAiTells(generatedCoverLetter)) {
      expect(tell.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("does not flag a legitimate technical use of a soft-flagged word", () => {
    // "harness" as a noun is normal engineering vocabulary
    expect(
      detectAiTells("I built an eval harness that runs the golden set twice."),
    ).toHaveLength(0);
  });
});

describe("aiTellScore", () => {
  it("is 0 for clean prose", () => {
    expect(aiTellScore(humanCoverLetter)).toBe(0);
  });

  it("is substantially higher for generated prose", () => {
    expect(aiTellScore(generatedCoverLetter)).toBeGreaterThan(aiTellScore(humanCoverLetter));
  });

  it("normalises by length so a long clean document does not accumulate a penalty", () => {
    const long = humanCoverLetter.repeat(5);
    expect(aiTellScore(long)).toBeCloseTo(aiTellScore(humanCoverLetter), 5);
  });

  it("returns 0 for empty input rather than NaN", () => {
    expect(aiTellScore("")).toBe(0);
  });
});

describe("needsHumanising", () => {
  it("passes human prose", () => {
    expect(needsHumanising(humanCoverLetter)).toBe(false);
  });

  it("blocks generated prose from reaching the approval queue", () => {
    expect(needsHumanising(generatedCoverLetter)).toBe(true);
  });

  it("uses the published threshold", () => {
    expect(TELL_THRESHOLD).toBeGreaterThan(0);
  });
});
