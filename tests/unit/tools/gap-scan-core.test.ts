/**
 * Gap Scanner pure core — prompt bank, presence detection, aggregation,
 * Gap Score, and rule-based diagnosis. Everything here is deterministic
 * and offline ($0): answers are scripted strings, timestamps injected.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateGapReport,
  buildPromptBank,
  detectPresence,
  normalizeDomain,
  MAX_PROMPT_BANK,
  type ScanCompany,
  type SurfaceRun,
  type WeightedPrompt,
} from "../../../src/tools/gap-scan-core.js";

const TARGET: ScanCompany = { name: "Acme", domain: "acme.com" };
const COMP_A: ScanCompany = { name: "HubSpot", domain: "hubspot.com" };
const COMP_B: ScanCompany = { name: "Close", domain: "close.com" };

// ── buildPromptBank ───────────────────────────────────────────────────────────

describe("buildPromptBank", () => {
  const bank = buildPromptBank("CRM", [COMP_A, COMP_B], { year: 2026 });

  it("generates the spec's template classes: alternatives, vs, best-for, top", () => {
    const texts = bank.map((p) => p.text);
    expect(texts).toContain("HubSpot alternatives");
    expect(texts).toContain("Close alternatives");
    expect(texts).toContain("HubSpot vs Close");
    expect(texts).toContain("best CRM for startups");
    expect(texts).toContain("top CRM tools in 2026");
  });

  it("never anchors a prompt on the target's own name (scoring integrity)", () => {
    // The bank is built from category + competitors only — the target is not an input.
    expect(bank.every((p) => !p.text.includes("Acme"))).toBe(true);
  });

  it("weights comparison-intent prompts highest", () => {
    const byKind = Object.fromEntries(bank.map((p) => [p.kind, p.weight]));
    expect(byKind["alternatives"]).toBe(3);
    expect(byKind["vs"]).toBe(3);
    expect(byKind["best"]).toBe(2);
    expect(byKind["top"]).toBe(1);
  });

  it("is deterministic and duplicate-free", () => {
    const again = buildPromptBank("CRM", [COMP_A, COMP_B], { year: 2026 });
    expect(again).toEqual(bank);
    expect(new Set(bank.map((p) => p.text)).size).toBe(bank.length);
  });

  it("caps at maxPrompts, trimming lowest-intent prompts last-first", () => {
    const capped = buildPromptBank("CRM", [COMP_A, COMP_B], { year: 2026, maxPrompts: 3 });
    expect(capped).toHaveLength(3);
    // Highest-intent (alternatives) survive the cap.
    expect(capped.map((p) => p.kind)).toEqual(["alternatives", "alternatives", "vs"]);
  });

  it("never exceeds MAX_PROMPT_BANK even with 5 competitors and many segments", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `Comp${i}`, domain: `c${i}.com` }));
    const big = buildPromptBank("CRM", many, {
      year: 2026,
      segments: ["a", "b", "c", "d", "e", "f"],
      maxPrompts: 999,
    });
    expect(big.length).toBeLessThanOrEqual(MAX_PROMPT_BANK);
  });

  it("uses custom segments when provided", () => {
    const seg = buildPromptBank("CRM", [COMP_A], { year: 2026, segments: ["agencies"] });
    expect(seg.map((p) => p.text)).toContain("best CRM for agencies");
    expect(seg.map((p) => p.text)).not.toContain("best CRM for startups");
  });
});

// ── detectPresence ────────────────────────────────────────────────────────────

describe("detectPresence", () => {
  it("detects a case-insensitive name mention with word boundaries", () => {
    const p = detectPresence("Many teams pick ACME for this.", TARGET);
    expect(p.mentioned).toBe(true);
    expect(p.cited).toBe(false);
    expect(p.first_index).toBe(16);
  });

  it("does NOT match a name embedded in a longer word (Base vs Basecamp)", () => {
    const p = detectPresence("Basecamp is a popular choice.", { name: "Base", domain: "base.com" });
    expect(p.mentioned).toBe(false);
  });

  it("detects a domain citation (including behind www/https)", () => {
    const p = detectPresence("See https://www.acme.com/pricing for details.", TARGET);
    expect(p.cited).toBe(true);
    expect(p.mentioned).toBe(true); // dots are word boundaries — the name inside the domain also counts
  });

  it("citation without a name mention when the name differs from the domain", () => {
    const p = detectPresence("Docs live at getacme.io.", { name: "Acme HQ", domain: "getacme.io" });
    expect(p.cited).toBe(true);
    expect(p.mentioned).toBe(false);
  });

  it("returns first_index as the earliest of name or domain occurrence", () => {
    const p = detectPresence("acme.com is run by Acme.", TARGET);
    expect(p.first_index).toBe(0);
  });

  it("handles names containing regex metacharacters without throwing", () => {
    const p = detectPresence("Try Notion (AI) today.", { name: "Notion (AI)", domain: "notion.so" });
    expect(p.mentioned).toBe(true);
  });

  it("returns nulls for an answer with no presence", () => {
    expect(detectPresence("Nothing relevant here.", TARGET)).toEqual({
      mentioned: false,
      cited: false,
      first_index: null,
    });
  });
});

describe("normalizeDomain", () => {
  it("strips protocol, www, paths, and case", () => {
    expect(normalizeDomain("HTTPS://WWW.Acme.com/pricing?x=1")).toBe("acme.com");
    expect(normalizeDomain("acme.com")).toBe("acme.com");
  });
});

// ── aggregateGapReport ────────────────────────────────────────────────────────

const P_ALT: WeightedPrompt = { text: "HubSpot alternatives", kind: "alternatives", weight: 3 };
const P_BEST: WeightedPrompt = { text: "best CRM for startups", kind: "best", weight: 2 };

function run(surface: string, prompt: WeightedPrompt, runIdx: number, answer: string): SurfaceRun {
  return { surface, prompt, run: runIdx, ok: true, answer };
}

function failedRun(surface: string, prompt: WeightedPrompt, runIdx: number): SurfaceRun {
  return { surface, prompt, run: runIdx, ok: false, error: "HTTP 503" };
}

function aggregate(runs: SurfaceRun[], surfaces = ["chatgpt", "perplexity"]) {
  return aggregateGapReport({
    target: TARGET,
    competitors: [COMP_A, COMP_B],
    category: "CRM",
    runs,
    runsPerPrompt: 2,
    prompts: [P_ALT, P_BEST],
    surfaces,
    generatedAt: "2026-07-11T00:00:00.000Z",
  });
}

describe("aggregateGapReport", () => {
  const COMPETITOR_HEAVY = "For CRM, HubSpot (hubspot.com) and Close are the usual picks.";
  const TARGET_PRESENT = "Acme is a strong option; see acme.com.";

  it("computes appearance, citation, and completion rates from raw runs", () => {
    const report = aggregate([
      run("chatgpt", P_ALT, 1, COMPETITOR_HEAVY),
      run("chatgpt", P_ALT, 2, COMPETITOR_HEAVY),
      run("perplexity", P_BEST, 1, TARGET_PRESENT),
      failedRun("perplexity", P_BEST, 2),
    ]);

    expect(report.runs_total).toBe(4);
    expect(report.runs_completed).toBe(3);
    expect(report.completion_rate).toBe(0.75);

    const [target, hubspot, close] = report.companies;
    expect(target!.appearance_rate).toBe(0.33); // 1 of 3 completed
    expect(target!.cited_rate).toBe(0.33);
    expect(hubspot!.appearance_rate).toBe(0.67);
    expect(hubspot!.cited_rate).toBe(0.67);
    expect(close!.appearance_rate).toBe(0.67);
    expect(close!.cited_rate).toBe(0);
  });

  it("splits rates per surface", () => {
    const report = aggregate([
      run("chatgpt", P_ALT, 1, COMPETITOR_HEAVY),
      run("perplexity", P_BEST, 1, TARGET_PRESENT),
    ]);
    const target = report.companies[0]!;
    expect(target.per_surface["chatgpt"]).toEqual({ runs: 1, appearances: 0, rate: 0 });
    expect(target.per_surface["perplexity"]).toEqual({ runs: 1, appearances: 1, rate: 1 });
  });

  it("gap score is 100 when competitors always appear and the target never does", () => {
    const report = aggregate([
      run("chatgpt", P_ALT, 1, COMPETITOR_HEAVY),
      run("chatgpt", P_BEST, 1, COMPETITOR_HEAVY),
    ]);
    expect(report.gap_score).toBe(100);
    expect(report.share_of_answer_rank[0]).not.toBe("Acme");
  });

  it("gap score is 0 when the target matches the best competitor", () => {
    const both = "Acme and HubSpot are both fine.";
    const report = aggregate([run("chatgpt", P_ALT, 1, both), run("chatgpt", P_BEST, 1, both)]);
    expect(report.gap_score).toBe(0);
  });

  it("weights comparison prompts more in the gap score (intent weighting)", () => {
    // Competitor appears ONLY on the weight-3 alternatives prompt; target ONLY on
    // the weight-2 best prompt. Weighted rates: comp 3/5, target 2/5 → gap 20.
    const report = aggregate([
      run("chatgpt", P_ALT, 1, "HubSpot is the pick."),
      run("chatgpt", P_BEST, 1, "Acme is the pick."),
    ]);
    expect(report.gap_score).toBe(20);
  });

  it("computes first_mention_rate (who leads the answer)", () => {
    const report = aggregate([run("chatgpt", P_ALT, 1, "HubSpot first, then Acme.")]);
    expect(report.companies[1]!.first_mention_rate).toBe(1);
    expect(report.companies[0]!.first_mention_rate).toBe(0);
  });

  it("collects evidence excerpts only from runs where competitors appear WITHOUT the target", () => {
    const report = aggregate([
      run("chatgpt", P_ALT, 1, COMPETITOR_HEAVY),
      run("perplexity", P_BEST, 1, TARGET_PRESENT),
    ]);
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]!.surface).toBe("chatgpt");
    expect(report.evidence[0]!.competitors_named).toEqual(["HubSpot", "Close"]);
    expect(report.evidence[0]!.excerpt).toContain("HubSpot");
  });

  it("dedupes evidence to one excerpt per prompt (N runs of one prompt ≠ N samples)", () => {
    const report = aggregate([
      run("chatgpt", P_ALT, 1, COMPETITOR_HEAVY),
      run("chatgpt", P_ALT, 2, COMPETITOR_HEAVY),
      run("perplexity", P_BEST, 1, "Close wins here."),
    ]);
    expect(report.evidence.map((e) => e.prompt)).toEqual([P_ALT.text, P_BEST.text]);
  });

  it("survives zero completed runs (total function, no NaN)", () => {
    const report = aggregate([failedRun("chatgpt", P_ALT, 1)]);
    expect(report.completion_rate).toBe(0);
    expect(report.gap_score).toBe(0);
    expect(report.companies[0]!.appearance_rate).toBe(0);
  });
});

// ── Diagnosis rules ───────────────────────────────────────────────────────────

describe("diagnosed causes", () => {
  it("flags missing comparison pages when competitors own vs/alternatives prompts", () => {
    const report = aggregate([
      run("chatgpt", P_ALT, 1, "HubSpot and Close dominate here."),
      run("chatgpt", P_ALT, 2, "HubSpot again."),
    ]);
    expect(report.causes.map((c) => c.cause)).toContain(
      "No comparison/alternatives pages — competitors own the highest-intent prompts",
    );
  });

  it("flags weak entity signals when the target is mentioned but never cited", () => {
    const mentionedNotCited = "Acme is okay. HubSpot (hubspot.com) leads.";
    const report = aggregate([
      run("chatgpt", P_ALT, 1, mentionedNotCited),
      run("chatgpt", P_BEST, 1, mentionedNotCited),
    ]);
    expect(report.causes.map((c) => c.cause)).toContain("Missing schema/entity signals — mentioned but not cited");
  });

  it("flags thin third-party corroboration when the target is near-invisible", () => {
    const report = aggregate([run("chatgpt", P_ALT, 1, "HubSpot only.")]);
    expect(report.causes.map((c) => c.cause)).toContain(
      "Thin third-party corroboration — reviews, G2/Capterra, Reddit presence",
    );
  });

  it("reports no causes when the target is fully visible", () => {
    const visible = "Acme (acme.com) leads; HubSpot follows.";
    const report = aggregate([run("chatgpt", P_ALT, 1, visible), run("chatgpt", P_BEST, 1, visible)]);
    expect(report.causes).toEqual([]);
    expect(report.gap_score).toBe(0);
  });

  it("caps causes at 3", () => {
    const report = aggregate([run("chatgpt", P_ALT, 1, "HubSpot only."), run("chatgpt", P_ALT, 2, "HubSpot only.")]);
    expect(report.causes.length).toBeLessThanOrEqual(3);
  });
});
