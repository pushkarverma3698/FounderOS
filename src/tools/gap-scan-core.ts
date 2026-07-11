/**
 * FounderOS — AI Visibility Gap Scanner: pure core
 * =================================================
 * Layer 1 of the Turicks lead-acquisition spec (read-only detection layer).
 * Everything in this file is a pure, deterministic function: prompt-bank
 * generation, mention/citation detection, appearance-rate aggregation, the
 * Gap Score, and rule-based cause diagnosis. No network, no models, no clock —
 * callers inject answers and timestamps, so the whole pipeline unit-tests at $0.
 *
 * Determinism rule (CLAUDE.md): parsing/scoring/diagnosis are code, never
 * prompt instructions. The only LLM involvement in a scan is the surfaces
 * themselves (src/tools/gap-scanner.ts), whose answers are DATA to this module.
 */

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface ScanCompany {
  name: string;
  /** Bare domain, e.g. "acme.com" (protocol/www stripped by normalizeDomain). */
  domain: string;
}

export type PromptKind = "best" | "top" | "alternatives" | "vs";

export interface WeightedPrompt {
  text: string;
  kind: PromptKind;
  /** Buying-intent weight — comparison-intent prompts count more in the Gap Score. */
  weight: number;
}

/** One sampled answer: (surface × prompt × run). ok:false = surface call failed. */
export interface SurfaceRun {
  surface: string;
  prompt: WeightedPrompt;
  /** 1-based sample index (spec: N runs per prompt — answers are non-deterministic). */
  run: number;
  ok: boolean;
  answer?: string;
  error?: string;
}

// ── Prompt bank (spec §2.1 templates, competitor-anchored) ────────────────────

export const MAX_PROMPT_BANK = 25;
const DEFAULT_SEGMENTS = ["startups", "small teams", "enterprise"];

/** Comparison-intent prompts (alternatives / vs) carry the highest buying intent. */
const KIND_WEIGHTS: Record<PromptKind, number> = { alternatives: 3, vs: 3, best: 2, top: 1 };

export interface PromptBankOpts {
  /** Buyer segments for "best X for Y" prompts (default: startups/small teams/enterprise). */
  segments?: string[];
  /** Year for the "top tools in YYYY" prompt — inject for deterministic tests. */
  year: number;
  maxPrompts?: number;
}

/**
 * Generate the buyer-intent prompt bank for one category + competitor set.
 * Deliberately NEVER anchors a prompt on the target's own name — a prompt that
 * contains the target guarantees a trivial mention in the answer and would
 * inflate the target's appearance rate (scoring integrity).
 */
export function buildPromptBank(category: string, competitors: ScanCompany[], opts: PromptBankOpts): WeightedPrompt[] {
  const segments = (opts.segments?.length ? opts.segments : DEFAULT_SEGMENTS).slice(0, 5);
  const cap = Math.min(Math.max(opts.maxPrompts ?? MAX_PROMPT_BANK, 1), MAX_PROMPT_BANK);
  const cat = category.trim();

  const bank: WeightedPrompt[] = [];
  const push = (text: string, kind: PromptKind) => {
    if (!bank.some((p) => p.text === text)) bank.push({ text, kind, weight: KIND_WEIGHTS[kind] });
  };

  // Highest-intent first so the cap trims the weakest prompts, not the strongest.
  for (const c of competitors) push(`${c.name} alternatives`, "alternatives");
  for (let i = 0; i < competitors.length; i++) {
    for (let j = i + 1; j < competitors.length; j++) {
      push(`${competitors[i]!.name} vs ${competitors[j]!.name}`, "vs");
    }
  }
  for (const seg of segments) push(`best ${cat} for ${seg}`, "best");
  push(`top ${cat} tools in ${opts.year}`, "top");
  push(`which ${cat} should I use`, "top");

  return bank.slice(0, cap);
}

// ── Mention / citation detection ──────────────────────────────────────────────

export interface Presence {
  /** Company NAME appears in the answer (word-boundary, case-insensitive). */
  mentioned: boolean;
  /** Company DOMAIN appears in the answer — cited, not merely mentioned. */
  cited: boolean;
  /** Index of the earliest name/domain occurrence (first-mention ranking). */
  first_index: number | null;
}

export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectPresence(answer: string, company: ScanCompany): Presence {
  const nameRe = new RegExp(`(?<![\\w])${escapeRegex(company.name)}(?![\\w])`, "i");
  const nameMatch = nameRe.exec(answer);
  const domain = normalizeDomain(company.domain);
  const domainIdx = domain ? answer.toLowerCase().indexOf(domain) : -1;

  const mentioned = nameMatch !== null;
  const cited = domainIdx >= 0;
  const indices = [nameMatch?.index, domainIdx >= 0 ? domainIdx : undefined].filter(
    (i): i is number => typeof i === "number",
  );
  return { mentioned, cited, first_index: indices.length > 0 ? Math.min(...indices) : null };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export interface SurfaceStats {
  runs: number;
  appearances: number;
  rate: number;
}

export interface CompanyStats {
  name: string;
  domain: string;
  is_target: boolean;
  /** Fraction of completed runs where the company is mentioned at all. */
  appearance_rate: number;
  /** Fraction of completed runs where the company's DOMAIN is cited. */
  cited_rate: number;
  /** Fraction of completed runs where the company appears before every other company. */
  first_mention_rate: number;
  /** Appearance rate weighted by prompt buying-intent — feeds the Gap Score. */
  weighted_appearance_rate: number;
  per_surface: Record<string, SurfaceStats>;
}

export interface DiagnosedCause {
  cause: string;
  evidence: string;
}

export interface EvidenceSample {
  surface: string;
  prompt: string;
  /** Answer excerpt around the competitor mention — the "screenshot" of the run. */
  excerpt: string;
  competitors_named: string[];
}

export interface GapReportData {
  target: ScanCompany;
  competitors: ScanCompany[];
  category: string;
  surfaces: string[];
  prompts: WeightedPrompt[];
  runs_per_prompt: number;
  runs_total: number;
  runs_completed: number;
  completion_rate: number;
  companies: CompanyStats[];
  /** Company names ranked by weighted appearance (share-of-answer rank). */
  share_of_answer_rank: string[];
  /** 0–100: weighted best-competitor appearance minus target appearance. */
  gap_score: number;
  causes: DiagnosedCause[];
  evidence: EvidenceSample[];
  generated_at: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const EXCERPT_RADIUS = 140;

interface AggregateInput {
  target: ScanCompany;
  competitors: ScanCompany[];
  category: string;
  runs: SurfaceRun[];
  runsPerPrompt: number;
  prompts: WeightedPrompt[];
  surfaces: string[];
  generatedAt: string;
}

/** Compute the full report from raw sampled answers. Pure and total. */
export function aggregateGapReport(input: AggregateInput): GapReportData {
  const companies = [input.target, ...input.competitors];
  const completed = input.runs.filter((r) => r.ok && typeof r.answer === "string");

  // presence[runIdx][companyIdx] — computed once, reused by every metric below.
  const presence = completed.map((r) => companies.map((c) => detectPresence(r.answer!, c)));

  const stats: CompanyStats[] = companies.map((c, ci) => {
    let mentions = 0;
    let cites = 0;
    let firsts = 0;
    let weightedHits = 0;
    let weightTotal = 0;
    const perSurface: Record<string, SurfaceStats> = Object.fromEntries(
      input.surfaces.map((s) => [s, { runs: 0, appearances: 0, rate: 0 }]),
    );

    completed.forEach((r, ri) => {
      const p = presence[ri]![ci]!;
      const appeared = p.mentioned || p.cited;
      if (appeared) mentions += 1;
      if (p.cited) cites += 1;
      weightTotal += r.prompt.weight;
      if (appeared) weightedHits += r.prompt.weight;

      const mine = p.first_index;
      const others = presence[ri]!.filter((_, oi) => oi !== ci).map((o) => o.first_index);
      if (mine !== null && others.every((o) => o === null || mine < o)) firsts += 1;

      const s = perSurface[r.surface];
      if (s) {
        s.runs += 1;
        if (appeared) s.appearances += 1;
      }
    });

    for (const s of Object.values(perSurface)) s.rate = s.runs > 0 ? round2(s.appearances / s.runs) : 0;
    const n = completed.length;
    return {
      name: c.name,
      domain: normalizeDomain(c.domain),
      is_target: ci === 0,
      appearance_rate: n > 0 ? round2(mentions / n) : 0,
      cited_rate: n > 0 ? round2(cites / n) : 0,
      first_mention_rate: n > 0 ? round2(firsts / n) : 0,
      weighted_appearance_rate: weightTotal > 0 ? round2(weightedHits / weightTotal) : 0,
      per_surface: perSurface,
    };
  });

  const target = stats[0]!;
  const competitorStats = stats.slice(1);
  const bestCompetitor = Math.max(0, ...competitorStats.map((s) => s.weighted_appearance_rate));
  const gapScore = Math.round(Math.min(1, Math.max(0, bestCompetitor - target.weighted_appearance_rate)) * 100);

  return {
    target: { name: input.target.name, domain: normalizeDomain(input.target.domain) },
    competitors: input.competitors.map((c) => ({ name: c.name, domain: normalizeDomain(c.domain) })),
    category: input.category,
    surfaces: input.surfaces,
    prompts: input.prompts,
    runs_per_prompt: input.runsPerPrompt,
    runs_total: input.runs.length,
    runs_completed: completed.length,
    completion_rate: input.runs.length > 0 ? round2(completed.length / input.runs.length) : 0,
    companies: stats,
    share_of_answer_rank: [...stats]
      .sort((a, b) => b.weighted_appearance_rate - a.weighted_appearance_rate || a.name.localeCompare(b.name))
      .map((s) => s.name),
    gap_score: gapScore,
    causes: diagnoseCauses(target, competitorStats, completed, presence),
    evidence: collectEvidence(input.target, input.competitors, completed, presence),
    generated_at: input.generatedAt,
  };
}

// ── Diagnosis (spec §2.1: top-3 causes, rule-based ⇒ deterministic) ───────────

function rateOn(kinds: PromptKind[], runs: SurfaceRun[], presence: Presence[][], ci: number): number | null {
  let hits = 0;
  let n = 0;
  runs.forEach((r, ri) => {
    if (!kinds.includes(r.prompt.kind)) return;
    n += 1;
    const p = presence[ri]![ci]!;
    if (p.mentioned || p.cited) hits += 1;
  });
  return n > 0 ? hits / n : null;
}

function diagnoseCauses(
  target: CompanyStats,
  competitors: CompanyStats[],
  completed: SurfaceRun[],
  presence: Presence[][],
): DiagnosedCause[] {
  const causes: DiagnosedCause[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  // 1. Comparison-intent gap → missing comparison/alternatives pages.
  const targetComp = rateOn(["vs", "alternatives"], completed, presence, 0);
  let bestCompComp = 0;
  let bestCompName = "";
  competitors.forEach((c, i) => {
    const r = rateOn(["vs", "alternatives"], completed, presence, i + 1) ?? 0;
    if (r > bestCompComp) {
      bestCompComp = r;
      bestCompName = c.name;
    }
  });
  if (targetComp !== null && bestCompComp >= 0.4 && targetComp < bestCompComp / 2) {
    causes.push({
      cause: "No comparison/alternatives pages — competitors own the highest-intent prompts",
      evidence: `On "vs"/"alternatives" prompts ${bestCompName} appears in ${pct(bestCompComp)} of answers vs ${pct(targetComp)} for ${target.name}. Those pages are what AI engines cite for comparison queries.`,
    });
  }

  // 2. Mentioned but never cited → weak entity/schema signals.
  if (target.appearance_rate > 0 && target.cited_rate < target.appearance_rate * 0.25) {
    causes.push({
      cause: "Missing schema/entity signals — mentioned but not cited",
      evidence: `${target.name} is named in ${pct(target.appearance_rate)} of answers but its domain is cited in only ${pct(target.cited_rate)} — engines don't treat the site as the authoritative source for the brand.`,
    });
  }

  // 3. Near-zero presence overall → thin third-party corroboration.
  if (target.appearance_rate < 0.1) {
    causes.push({
      cause: "Thin third-party corroboration — reviews, G2/Capterra, Reddit presence",
      evidence: `${target.name} appears in only ${pct(target.appearance_rate)} of sampled answers. AI engines lean on third-party corroboration (review sites, community threads); without it a brand is invisible even when its own site ranks.`,
    });
  }

  return causes.slice(0, 3);
}

// ── Evidence excerpts (the "screenshot" proxy — verbatim answer fragments) ────

function collectEvidence(
  target: ScanCompany,
  competitors: ScanCompany[],
  completed: SurfaceRun[],
  presence: Presence[][],
  max = 3,
): EvidenceSample[] {
  const samples: EvidenceSample[] = [];
  const seenPrompts = new Set<string>();
  for (let ri = 0; ri < completed.length && samples.length < max; ri++) {
    // One excerpt per prompt — N runs of the same prompt read as duplicates on a 1-pager.
    if (seenPrompts.has(completed[ri]!.prompt.text)) continue;
    const targetPresent = presence[ri]![0]!.mentioned || presence[ri]![0]!.cited;
    if (targetPresent) continue;
    const named = competitors.filter((_, i) => {
      const p = presence[ri]![i + 1]!;
      return p.mentioned || p.cited;
    });
    if (named.length === 0) continue;
    const run = completed[ri]!;
    const firstIdx = Math.min(
      ...named.map((_, k) => presence[ri]![competitors.indexOf(named[k]!) + 1]!.first_index ?? 0),
    );
    const start = Math.max(0, firstIdx - EXCERPT_RADIUS);
    const excerpt = run.answer!.slice(start, firstIdx + EXCERPT_RADIUS).replace(/\s+/g, " ").trim();
    seenPrompts.add(run.prompt.text);
    samples.push({
      surface: run.surface,
      prompt: run.prompt.text,
      excerpt: `${start > 0 ? "…" : ""}${excerpt}…`,
      competitors_named: named.map((c) => c.name),
    });
  }
  return samples;
}
