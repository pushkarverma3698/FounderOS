/**
 * Unit tests for the brand voice validator.
 *
 * Why: brand voice was prompt-only (LLM might ignore it). This validator
 * provides a deterministic hard gate BEFORE interrupt() is called — so the
 * HITL card only ever shows clean, brand-compliant content.
 *
 * Pure functions → no mocks needed.
 * RED: these fail until src/infra/brand-validator.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import { validateBrandVoice, brandFixGuidance, BANNED_PHRASES } from "../../../src/infra/brand-validator.js";

// ── Banned phrases ─────────────────────────────────────────────────────────────

describe("banned phrases", () => {
  it("exports exactly 22 banned phrases", () => {
    expect(BANNED_PHRASES).toHaveLength(22);
  });

  // Parameterized: each phrase must be caught
  const cases: [string, string][] = [
    ["excited to share", "We are excited to share our results."],
    ["game-changer", "This is a game-changer for SMEs."],
    ["game changer", "A real game changer."],
    ["synergy", "We create synergy between teams."],
    ["circle back", "Let's circle back on this."],
    ["excited to announce", "Excited to announce our launch."],
    ["thrilled to share", "Thrilled to share this update."],
    ["innovative solution", "Our innovative solution helps founders."],
    ["i wanted to reach out", "Hi, I wanted to reach out about..."],
    ["hope this finds you well", "Hope this finds you well."],
    ["just following up", "Just following up on my last email."],
    ["quick question", "Quick question about your stack."],
    ["touch base", "Wanted to touch base with you."],
    ["we help companies like yours", "We help companies like yours grow."],
    ["disruptive", "Our disruptive approach changes everything."],
    ["bleeding edge", "Built on bleeding edge technology."],
    ["leverage", "We leverage AI to automate your ops."],
    ["paradigm shift", "This is a paradigm shift in automation."],
    ["scalable solution", "A fully scalable solution."],
    ["deep dive", "Let's do a deep dive into the data."],
    ["move the needle", "This will move the needle."],
    ["low-hanging fruit", "Start with the low-hanging fruit."],
  ];

  for (const [phrase, text] of cases) {
    it(`catches "${phrase}"`, () => {
      const result = validateBrandVoice(text, "general");
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.includes(phrase))).toBe(true);
    });
  }

  it("is case-insensitive: 'Game-Changer' is caught", () => {
    const result = validateBrandVoice("This is a Game-Changer.", "general");
    expect(result.valid).toBe(false);
  });

  it("returns valid: true for clean general text", () => {
    const result = validateBrandVoice("We build AI automation tools for SME founders.", "general");
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ── LinkedIn channel ───────────────────────────────────────────────────────────

const GOOD_HOOK = "7 founders told me they can't hire a dev team.";
const GOOD_BODY = `
We built FounderOS in 3 weeks. Here's exactly what we shipped:

- Telegram-native AI operating system for solo founders
- 6 departments: research, comms, engineering, marketing, sales, prospecting
- Human-in-the-loop approval before every external action (emails, LinkedIn posts, GitHub writes)
- LangGraph checkpointing for crash-safe HITL recovery

The whole thing is roughly 500 lines of code because we used prebuilt LangGraph primitives instead of writing custom orchestration.

Most agencies charging for AI automation are delivering slide decks. We deliver working, production-grade systems that run on Telegram and cost less than a part-time hire.

This week I used it to check my inbox, draft a cold outreach email, score a prospect against our ICP, and push a GitHub issue — all from Telegram, all approved before anything went out.

What's the most painful part of running your agency without a full-time tech team?
`.trim();

const goodLinkedInPost = `${GOOD_HOOK}\n\n${GOOD_BODY}`;

// ~175 words — within 150-300 range
describe("linkedin channel", () => {
  it("passes a well-formed post", () => {
    const result = validateBrandVoice(goodLinkedInPost, "linkedin");
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when post is too short (< 150 words)", () => {
    const short = `${GOOD_HOOK}\n\nShort post.`;
    const result = validateBrandVoice(short, "linkedin");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("word count"))).toBe(true);
  });

  it("fails when post is too long (> 300 words)", () => {
    const long = `${goodLinkedInPost}\n\n` + "extra word ".repeat(200);
    const result = validateBrandVoice(long, "linkedin");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("word count"))).toBe(true);
  });

  it("fails when line 1 has no hook (no number and no '?')", () => {
    const noHook = `We are building something new.\n\n${GOOD_BODY}`;
    const result = validateBrandVoice(noHook, "linkedin");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("hook"))).toBe(true);
  });

  it("accepts a hook with a '?' on line 1", () => {
    const questionHook = `What if you could run your agency from Telegram?\n\n${GOOD_BODY}`;
    const result = validateBrandVoice(questionHook, "linkedin");
    // only check that hook rule passes (other rules may vary)
    expect(result.violations.some((v) => v.includes("hook"))).toBe(false);
  });

  it("fails when more than 3 emojis are used", () => {
    const tooManyEmoji = `${GOOD_HOOK}\n\n🚀✅🎯💡 four emojis here.\n\n${GOOD_BODY}`;
    const result = validateBrandVoice(tooManyEmoji, "linkedin");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("emoji"))).toBe(true);
  });

  it("allows up to 3 emojis", () => {
    const threeEmoji = `${GOOD_HOOK} 🚀\n\n${GOOD_BODY} ✅💡`;
    const result = validateBrandVoice(threeEmoji, "linkedin");
    expect(result.violations.some((v) => v.includes("emoji"))).toBe(false);
  });

  it("still catches banned phrases in a linkedin post", () => {
    const withBanned = goodLinkedInPost + "\nThis is a game-changer.";
    const result = validateBrandVoice(withBanned, "linkedin");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("game-changer"))).toBe(true);
  });
});

// ── Outreach channel ──────────────────────────────────────────────────────────

const GOOD_OUTREACH = `Hi Alex,

Saw you're scaling ops at Acme without a full-time tech team — Turicks builds AI automation tools that get founders unstuck in 3–5 days.

Worth a 20-min call to see if it fits?

Pushkar, Turicks`;

describe("outreach channel", () => {
  it("passes a well-formed cold email (≤150 words)", () => {
    const result = validateBrandVoice(GOOD_OUTREACH, "outreach");
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when email exceeds 150 words", () => {
    const long = GOOD_OUTREACH + "\n\n" + "extra word ".repeat(100);
    const result = validateBrandVoice(long, "outreach");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("word count"))).toBe(true);
  });

  it("catches 'hope this finds you well' opener in outreach", () => {
    const opener = `Hi Alex,\n\nHope this finds you well. ${GOOD_OUTREACH}`;
    const result = validateBrandVoice(opener, "outreach");
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("hope this finds you well"))).toBe(true);
  });

  it("catches 'just following up' in outreach", () => {
    const followUp = `Hi Alex,\n\nJust following up on my last email.`;
    const result = validateBrandVoice(followUp, "outreach");
    expect(result.valid).toBe(false);
  });
});

// ── Deterministic fix guidance ─────────────────────────────────────────────────

describe("brandFixGuidance", () => {
  it("returns '' for a clean draft", () => {
    expect(brandFixGuidance(goodLinkedInPost, "linkedin")).toBe("");
  });

  it("gives the exact word delta for a too-short linkedin post", () => {
    const short = `${GOOD_HOOK}\n\nShort post body here.`; // well under 150
    const msg = brandFixGuidance(short, "linkedin");
    // exact additive delta, not a generic "too low"
    expect(msg).toMatch(/Add at least \d+ more words/);
    expect(msg).toMatch(/do NOT delete existing content/);
    expect(msg).not.toMatch(/word count too low/);
  });

  it("gives the exact word delta for a too-long outreach email", () => {
    const long = GOOD_OUTREACH + "\n\n" + "extra word ".repeat(100);
    const msg = brandFixGuidance(long, "outreach");
    expect(msg).toMatch(/Cut at least \d+ words/);
    expect(msg).not.toMatch(/word count too high/);
  });

  it("passes banned-phrase / hook violations through verbatim (no numeric delta)", () => {
    const noHook = `We are building something new.\n\n${GOOD_BODY}`;
    const msg = brandFixGuidance(noHook, "linkedin");
    expect(msg).toMatch(/hook/);
  });
});
