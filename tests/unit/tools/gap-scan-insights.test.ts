/**
 * Gap Scanner insights — the multi-angle second pass (funnel, threats,
 * consistency, stake, self-critique). All pure and offline ($0): reports are
 * built by aggregateGapReport from scripted runs, insights derived from both.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateGapReport,
  type ScanCompany,
  type SurfaceRun,
  type WeightedPrompt,
} from "../../../src/tools/gap-scan-core.js";
import { deriveInsights } from "../../../src/tools/gap-scan-insights.js";
import { renderGapReport } from "../../../src/tools/gap-scan-render.js";

const TARGET: ScanCompany = { name: "Acme", domain: "acme.com" };
const COMP_A: ScanCompany = { name: "HubSpot", domain: "hubspot.com" };
const COMP_B: ScanCompany = { name: "Close", domain: "close.com" };

const P_ALT: WeightedPrompt = { text: "HubSpot alternatives", kind: "alternatives", weight: 3 };
const P_VS: WeightedPrompt = { text: "HubSpot vs Close", kind: "vs", weight: 3 };
const P_BEST: WeightedPrompt = { text: "best CRM for startups", kind: "best", weight: 2 };

function run(surface: string, prompt: WeightedPrompt, runIdx: number, answer: string): SurfaceRun {
  return { surface, prompt, run: runIdx, ok: true, answer };
}

function failed(surface: string, prompt: WeightedPrompt, runIdx: number): SurfaceRun {
  return { surface, prompt, run: runIdx, ok: false, error: "HTTP 503" };
}

function build(runs: SurfaceRun[], opts: { surfaces?: string[]; runsPerPrompt?: number } = {}) {
  const report = aggregateGapReport({
    target: TARGET,
    competitors: [COMP_A, COMP_B],
    category: "CRM",
    runs,
    runsPerPrompt: opts.runsPerPrompt ?? 2,
    prompts: [P_ALT, P_VS, P_BEST],
    surfaces: opts.surfaces ?? ["chatgpt", "perplexity"],
    generatedAt: "2026-07-11T00:00:00.000Z",
  });
  return { report, insights: deriveInsights(report, runs) };
}

const COMP_ONLY = "HubSpot (hubspot.com) leads; Close is the runner-up.";
const TARGET_ONLY = "Acme (acme.com) is the clear pick.";
const BOTH = "Acme and HubSpot are both solid.";

// ── Intent-funnel breakdown ───────────────────────────────────────────────────

describe("intent_breakdown", () => {
  it("splits target vs best-competitor rates per intent class and names the owner", () => {
    const { insights } = build([
      run("chatgpt", P_ALT, 1, COMP_ONLY), // alternatives: comp wins
      run("chatgpt", P_BEST, 1, TARGET_ONLY), // best: target wins
    ]);
    const byKind = Object.fromEntries(insights.intent_breakdown.map((b) => [b.kind, b]));
    expect(byKind["alternatives"]).toMatchObject({
      runs: 1,
      target_rate: 0,
      best_competitor: "HubSpot",
      best_competitor_rate: 1,
      owner: "HubSpot",
    });
    expect(byKind["best"]).toMatchObject({ target_rate: 1, owner: "Acme" });
  });

  it("marks equal rates as contested and skips intent classes with no completed runs", () => {
    const { insights } = build([run("chatgpt", P_VS, 1, BOTH)]);
    expect(insights.intent_breakdown).toHaveLength(1);
    expect(insights.intent_breakdown[0]).toMatchObject({ kind: "vs", owner: "contested" });
  });

  it("orders classes by buying intent (alternatives before best)", () => {
    const { insights } = build([run("chatgpt", P_BEST, 1, BOTH), run("chatgpt", P_ALT, 1, BOTH)]);
    expect(insights.intent_breakdown.map((b) => b.kind)).toEqual(["alternatives", "best"]);
  });
});

// ── Threat profile ────────────────────────────────────────────────────────────

describe("threats", () => {
  it("ranks competitors by composite threat index (appearance + first mention + citation)", () => {
    const { insights } = build([
      run("chatgpt", P_ALT, 1, COMP_ONLY),
      run("chatgpt", P_VS, 1, COMP_ONLY),
      run("chatgpt", P_BEST, 1, COMP_ONLY),
    ]);
    // HubSpot always appears first AND is cited; Close appears but never leads.
    expect(insights.threats[0]!.name).toBe("HubSpot");
    expect(insights.threats[0]!.threat).toBe("primary");
    expect(insights.threats[0]!.threat_index).toBeGreaterThan(insights.threats[1]!.threat_index);
  });

  it("grades an absent competitor as minor", () => {
    const { insights } = build([run("chatgpt", P_ALT, 1, "HubSpot only, nobody else.")]);
    const close = insights.threats.find((t) => t.name === "Close")!;
    expect(close.threat).toBe("minor");
    expect(close.threat_index).toBe(0);
  });
});

// ── Surface divergence ────────────────────────────────────────────────────────

describe("surface_divergence", () => {
  it("flags a sharp per-engine split for the target", () => {
    const { insights } = build([
      run("chatgpt", P_ALT, 1, TARGET_ONLY),
      run("chatgpt", P_ALT, 2, TARGET_ONLY),
      run("perplexity", P_ALT, 1, COMP_ONLY),
      run("perplexity", P_ALT, 2, COMP_ONLY),
    ]);
    expect(insights.surface_divergence.divergent).toBe(true);
    expect(insights.surface_divergence.strongest).toEqual({ surface: "chatgpt", rate: 1 });
    expect(insights.surface_divergence.weakest).toEqual({ surface: "perplexity", rate: 0 });
    expect(insights.surface_divergence.spread).toBe(1);
    // …and surfaces it as an additional cause.
    expect(insights.additional_causes.map((c) => c.cause).join()).toContain("Surface-specific gap");
  });

  it("does not flag when rates are close or a surface has <2 runs", () => {
    const even = build([
      run("chatgpt", P_ALT, 1, BOTH),
      run("chatgpt", P_ALT, 2, BOTH),
      run("perplexity", P_ALT, 1, BOTH),
      run("perplexity", P_ALT, 2, BOTH),
    ]);
    expect(even.insights.surface_divergence.divergent).toBe(false);

    const thin = build([run("chatgpt", P_ALT, 1, TARGET_ONLY), run("perplexity", P_ALT, 1, COMP_ONLY)]);
    expect(thin.insights.surface_divergence.divergent).toBe(false);
    expect(thin.insights.surface_divergence.strongest).toBeNull();
  });
});

// ── Volatility ────────────────────────────────────────────────────────────────

describe("volatility", () => {
  it("measures flicker: same prompt+surface, target present in some runs and absent in others", () => {
    const { insights } = build([
      run("chatgpt", P_ALT, 1, TARGET_ONLY),
      run("chatgpt", P_ALT, 2, COMP_ONLY), // flickers
      run("chatgpt", P_BEST, 1, TARGET_ONLY),
      run("chatgpt", P_BEST, 2, TARGET_ONLY), // stable
    ]);
    expect(insights.volatility).toEqual({ flicker_rate: 0.5, cells_measured: 2, cells_mixed: 1 });
  });

  it("raises the borderline-entity cause when most cells flicker", () => {
    const { insights } = build([
      run("chatgpt", P_ALT, 1, TARGET_ONLY),
      run("chatgpt", P_ALT, 2, COMP_ONLY),
      run("chatgpt", P_BEST, 1, TARGET_ONLY),
      run("chatgpt", P_BEST, 2, COMP_ONLY),
    ]);
    expect(insights.volatility.flicker_rate).toBe(1);
    expect(insights.additional_causes.map((c) => c.cause).join()).toContain("Borderline entity strength");
  });

  it("ignores single-run cells (no variance to measure)", () => {
    const { insights } = build([run("chatgpt", P_ALT, 1, TARGET_ONLY)]);
    expect(insights.volatility.cells_measured).toBe(0);
    expect(insights.volatility.flicker_rate).toBe(0);
  });
});

// ── Stake (measured, never an unsourced market stat) ──────────────────────────

describe("stake", () => {
  it("counts answers where a competitor appears WITHOUT the target", () => {
    const { insights } = build([
      run("chatgpt", P_ALT, 1, COMP_ONLY), // lost
      run("chatgpt", P_VS, 1, BOTH), // not lost (target present)
      run("chatgpt", P_BEST, 1, "Nobody relevant here."), // not lost (no competitor)
      failed("perplexity", P_ALT, 1), // not counted
    ]);
    expect(insights.stake).toEqual({ lost_answers: 1, completed: 3, lost_rate: 0.33 });
  });
});

// ── Positioning cause ─────────────────────────────────────────────────────────

describe("positioning cause", () => {
  it("flags present-but-never-first as weak positioning", () => {
    const trailing = "HubSpot leads the pack; Acme also exists.";
    const { insights } = build([
      run("chatgpt", P_ALT, 1, trailing),
      run("chatgpt", P_VS, 1, trailing),
      run("chatgpt", P_BEST, 1, trailing),
    ]);
    expect(insights.additional_causes.map((c) => c.cause).join()).toContain("Weak positioning");
  });

  it("does not flag when the target leads answers", () => {
    const { insights } = build([run("chatgpt", P_ALT, 1, "Acme first, HubSpot second.")]);
    expect(insights.additional_causes.map((c) => c.cause).join()).not.toContain("Weak positioning");
  });
});

// ── Confidence self-critique ──────────────────────────────────────────────────

describe("confidence", () => {
  it("grades a large clean multi-surface scan high with only the proxy caveat", () => {
    const runs: SurfaceRun[] = [];
    for (const surface of ["chatgpt", "perplexity"]) {
      for (const prompt of [P_ALT, P_VS, P_BEST, { ...P_BEST, text: "best CRM for agencies" }]) {
        for (let i = 1; i <= 3; i++) runs.push(run(surface, prompt, i, BOTH));
      }
    }
    const { insights } = build(runs, { runsPerPrompt: 3 });
    expect(insights.confidence.grade).toBe("high");
    expect(insights.confidence.caveats).toHaveLength(1);
    expect(insights.confidence.caveats[0]).toContain("directional");
  });

  it("downgrades for low completion, small N, single surface, and few runs per prompt", () => {
    const { report, insights } = build(
      [run("chatgpt", P_ALT, 1, BOTH), failed("chatgpt", P_ALT, 2), failed("chatgpt", P_VS, 1)],
      { surfaces: ["chatgpt"], runsPerPrompt: 1 },
    );
    expect(report.completion_rate).toBeLessThan(0.5);
    expect(insights.confidence.grade).toBe("low");
    const text = insights.confidence.caveats.join(" ");
    expect(text).toContain("Completion");
    expect(text).toContain("Small sample");
    expect(text).toContain("Single surface");
  });

  it("grades medium when only sample size is thin", () => {
    const runs: SurfaceRun[] = [];
    for (const surface of ["chatgpt", "perplexity"]) {
      for (const prompt of [P_ALT, P_VS, P_BEST]) {
        for (let i = 1; i <= 3; i++) runs.push(run(surface, prompt, i, BOTH));
      }
    }
    // 18 completed < 20 → exactly one penalty.
    const { insights } = build(runs, { runsPerPrompt: 3 });
    expect(insights.confidence.grade).toBe("medium");
  });
});

// ── Renderer integration ──────────────────────────────────────────────────────

describe("renderGapReport with insights", () => {
  it("renders funnel, threats, consistency, measured stake, and confidence sections", () => {
    const { report, insights } = build([
      run("chatgpt", P_ALT, 1, COMP_ONLY),
      run("chatgpt", P_ALT, 2, COMP_ONLY),
      run("perplexity", P_BEST, 1, TARGET_ONLY),
      run("perplexity", P_BEST, 2, COMP_ONLY),
    ]);
    const md = renderGapReport(report, insights);
    expect(md).toContain("## Where the funnel leaks (by buyer intent)");
    expect(md).toContain("## Competitor threat profile");
    expect(md).toContain("## Consistency check");
    expect(md).toContain("## Confidence:");
    // The stake line is measured from this scan's data, not a market claim.
    expect(md).toContain("3 of 4 sampled buyer questions");
    expect(md).not.toContain("4x organic");
  });

  it("renders additional causes after the core causes, capped at 5 total", () => {
    const { report, insights } = build([
      run("chatgpt", P_ALT, 1, COMP_ONLY),
      run("chatgpt", P_ALT, 2, COMP_ONLY),
    ]);
    const md = renderGapReport(report, insights);
    const numbered = md.match(/^\d+\. \*\*/gm) ?? [];
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.length).toBeLessThanOrEqual(5);
  });

  it("still renders a complete report without insights (backward compatible)", () => {
    const { report } = build([run("chatgpt", P_ALT, 1, COMP_ONLY)]);
    const md = renderGapReport(report);
    expect(md).toContain("# AI Visibility Gap Report — Acme");
    expect(md).not.toContain("## Confidence:");
    expect(md).toContain("Methodology:");
  });
});
