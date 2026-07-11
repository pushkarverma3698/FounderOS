/**
 * FounderOS — AI Visibility Gap Scanner tool (spec §2.1, Layer 1)
 * ================================================================
 * Read-only detection: given a target company + 3–5 competitors + a category,
 * sample buyer-intent prompts across AI answer surfaces N times each and report
 * appearance RATES (never single answers), a 0–100 Gap Score, diagnosed causes,
 * and a rendered 1-page Markdown report.
 *
 * Surfaces are INJECTED (same seam as kernel models) so the full scan pipeline
 * runs offline in unit tests with scripted answers at $0. Production surfaces:
 *   - google-ai   → Gemini + google_search grounding (AI-Overview-class proxy)
 *   - chatgpt     → OpenRouter openai/gpt-4o-mini
 *   - perplexity  → OpenRouter perplexity/sonar (built-in web search)
 * Fidelity caveat (spec): API ≠ consumer surface; rates are directional.
 *
 * Fail-soft: individual surface-call failures are recorded in the completion
 * rate; the tool only returns success:false when NO answer completed.
 */

import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";
import {
  aggregateGapReport,
  buildPromptBank,
  MAX_PROMPT_BANK,
  type GapReportData,
  type ScanCompany,
  type SurfaceRun,
  type WeightedPrompt,
} from "./gap-scan-core.js";
import { renderGapReport } from "./gap-scan-render.js";
import { deriveInsights, type GapInsights } from "./gap-scan-insights.js";

const log = childLogger({ module: "tool:scan_ai_visibility" });

// ── Surface seam ──────────────────────────────────────────────────────────────

export type SurfaceAnswer = { ok: true; answer: string } | { ok: false; error: string };

export interface Surface {
  id: string;
  ask(prompt: string): Promise<SurfaceAnswer>;
}

const SURFACE_TIMEOUT_MS = 45_000;
const GEMINI_GROUNDED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Default OpenRouter-backed surfaces; override via GAP_SCAN_SURFACES="id=model,id=model". */
const DEFAULT_OPENROUTER_SURFACES = "chatgpt=openai/gpt-4o-mini,perplexity=perplexity/sonar";

function soft(err: unknown): SurfaceAnswer {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** Gemini with google_search grounding — the Google-AI-answer proxy surface. */
export function geminiSurface(apiKey: string): Surface {
  return {
    id: "google-ai",
    async ask(prompt) {
      try {
        const res = await fetch(GEMINI_GROUNDED_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
          }),
          signal: AbortSignal.timeout(SURFACE_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `gemini HTTP ${res.status}` };
        const json = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const answer = (json.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        return answer ? { ok: true, answer } : { ok: false, error: "gemini returned empty answer" };
      } catch (err) {
        return soft(err);
      }
    },
  };
}

/** Any OpenRouter chat model as an answer surface (temp 0 is NOT set — we WANT the surface's natural sampling; N runs measure the variance). */
export function openrouterSurface(id: string, model: string, apiKey: string): Surface {
  return {
    id,
    async ask(prompt) {
      try {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(SURFACE_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `${id} HTTP ${res.status}` };
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const answer = json.choices?.[0]?.message?.content?.trim() ?? "";
        return answer ? { ok: true, answer } : { ok: false, error: `${id} returned empty answer` };
      } catch (err) {
        return soft(err);
      }
    },
  };
}

/** Parse GAP_SCAN_SURFACES ("id=provider/model,id=provider/model"). Exported for tests. */
export function parseSurfaceSpec(spec: string): Array<{ id: string; model: string }> {
  return spec
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq > 0 ? { id: pair.slice(0, eq).trim(), model: pair.slice(eq + 1).trim() } : null;
    })
    .filter((s): s is { id: string; model: string } => s !== null && s.id.length > 0 && s.model.length > 0);
}

/** Build the production surfaces from whatever keys are configured. */
export function buildDefaultSurfaces(env: NodeJS.ProcessEnv = process.env): Surface[] {
  const surfaces: Surface[] = [];
  const geminiKey = env["GOOGLE_GENERATIVE_AI_API_KEY"];
  if (geminiKey) surfaces.push(geminiSurface(geminiKey));
  const orKey = env["OPENROUTER_API_KEY"];
  if (orKey) {
    for (const { id, model } of parseSurfaceSpec(env["GAP_SCAN_SURFACES"] ?? DEFAULT_OPENROUTER_SURFACES)) {
      surfaces.push(openrouterSurface(id, model, orKey));
    }
  }
  return surfaces;
}

// ── Scan runner ───────────────────────────────────────────────────────────────

export const MAX_RUNS_PER_PROMPT = 5;
const DEFAULT_RUNS_PER_PROMPT = 3;
const DEFAULT_MAX_PROMPTS = 12;

export interface GapScanConfig {
  target: ScanCompany;
  competitors: ScanCompany[];
  category: string;
  segments?: string[];
  /** Samples per prompt per surface (1–5; spec baseline is 5, tool default 3). */
  runsPerPrompt?: number;
  maxPrompts?: number;
  year?: number;
}

export interface GapScanOutcome {
  report: GapReportData;
  insights: GapInsights;
  markdown: string;
}

/**
 * Run the scan: prompts × surfaces × N runs. One prompt's runs execute in
 * parallel (≤ surfaces×N in flight); prompts are sequential to stay polite to
 * providers. Injected `now` keeps report timestamps deterministic in tests.
 */
export async function runGapScan(
  config: GapScanConfig,
  surfaces: Surface[],
  now: () => Date = () => new Date(),
): Promise<GapScanOutcome> {
  const year = config.year ?? now().getUTCFullYear();
  const runsPerPrompt = Math.min(Math.max(config.runsPerPrompt ?? DEFAULT_RUNS_PER_PROMPT, 1), MAX_RUNS_PER_PROMPT);
  const prompts = buildPromptBank(config.category, config.competitors, {
    ...(config.segments ? { segments: config.segments } : {}),
    year,
    maxPrompts: Math.min(config.maxPrompts ?? DEFAULT_MAX_PROMPTS, MAX_PROMPT_BANK),
  });

  const runs: SurfaceRun[] = [];
  for (const prompt of prompts) {
    const batch = await Promise.all(
      surfaces.flatMap((surface) =>
        Array.from({ length: runsPerPrompt }, (_, i) =>
          surface.ask(prompt.text).then(
            (a): SurfaceRun =>
              a.ok
                ? { surface: surface.id, prompt, run: i + 1, ok: true, answer: a.answer }
                : { surface: surface.id, prompt, run: i + 1, ok: false, error: a.error },
          ),
        ),
      ),
    );
    runs.push(...batch);
  }

  const report = aggregateGapReport({
    target: config.target,
    competitors: config.competitors,
    category: config.category,
    runs,
    runsPerPrompt,
    prompts,
    surfaces: surfaces.map((s) => s.id),
    generatedAt: now().toISOString(),
  });
  const insights = deriveInsights(report, runs);
  return { report, insights, markdown: renderGapReport(report, insights) };
}

// ── Persistence (agents retrieve past scans; the learning-loop dataset §11) ───

export interface PersistOutcome {
  persisted: boolean;
  scan_id?: string;
  persist_error?: string;
}

/**
 * Save one finished scan to gap_scans. Dynamic import keeps the DB layer (and
 * its full-env validation) out of the $0 test/CLI path; a persistence failure
 * never voids the scan — the report already exists — but it is SURFACED in the
 * tool result (persist_error), never swallowed.
 */
async function persistScan(report: GapReportData, insights: GapInsights, markdown: string): Promise<PersistOutcome> {
  if (!process.env["DATABASE_URL"]) {
    return { persisted: false, persist_error: "DATABASE_URL not set — scan not saved to gap_scans" };
  }
  try {
    const { saveGapScan } = await import("../db/gap-scan-queries.js");
    const scan_id = await saveGapScan({
      target_name: report.target.name,
      target_domain: report.target.domain,
      category: report.category,
      gap_score: report.gap_score,
      confidence: insights.confidence.grade,
      completion_rate: String(report.completion_rate),
      runs_total: report.runs_total,
      surfaces: report.surfaces,
      report: report as unknown as Record<string, unknown>,
      insights: insights as unknown as Record<string, unknown>,
      markdown,
    });
    return { persisted: true, scan_id };
  } catch (err) {
    const persist_error = err instanceof Error ? err.message : String(err);
    log.warn({ err: persist_error }, "gap scan persistence failed");
    return { persisted: false, persist_error };
  }
}

// ── Args parsing (pure, exported for tests) ───────────────────────────────────

/** Parse "Name=domain.com, Other Name=other.io" into companies. */
export function parseCompetitors(raw: string): ScanCompany[] {
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      const name = pair.slice(0, eq).trim();
      const domain = pair.slice(eq + 1).trim();
      return name && domain ? { name, domain } : null;
    })
    .filter((c): c is ScanCompany => c !== null);
}

// ── UnifiedTool ───────────────────────────────────────────────────────────────

export const gapScannerTool: UnifiedTool = {
  name: "scan_ai_visibility",
  description:
    "Scan AI answer surfaces (ChatGPT-class, Perplexity-class, Google AI) for a company's visibility vs named " +
    "competitors on buyer-intent prompts. Returns appearance rates, a 0-100 Gap Score, diagnosed causes, and a " +
    "1-page Markdown gap report. Read-only; samples each prompt multiple times and reports rates, never single answers.",

  input_schema: {
    type: "object",
    properties: {
      company_name: { type: "string", description: "Target company name, e.g. 'Acme'" },
      domain: { type: "string", description: "Target company domain, e.g. 'acme.com'" },
      category: { type: "string", description: "Product category, e.g. 'CRM for SMBs'" },
      competitors: {
        type: "string",
        description: "Comma-separated Name=domain pairs, e.g. 'HubSpot=hubspot.com, Close=close.com' (1-5)",
      },
      runs_per_prompt: { type: "number", description: `Samples per prompt per surface (1-${MAX_RUNS_PER_PROMPT}, default ${DEFAULT_RUNS_PER_PROMPT})` },
      max_prompts: { type: "number", description: `Prompt bank cap (default ${DEFAULT_MAX_PROMPTS}, max ${MAX_PROMPT_BANK})` },
    },
    required: ["company_name", "domain", "category", "competitors"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const companyName = typeof args["company_name"] === "string" ? args["company_name"].trim() : "";
    const domain = typeof args["domain"] === "string" ? args["domain"].trim() : "";
    const category = typeof args["category"] === "string" ? args["category"].trim() : "";
    const competitors = typeof args["competitors"] === "string" ? parseCompetitors(args["competitors"]) : [];

    if (!companyName || !domain || !category) {
      return { success: false, error: "scan_ai_visibility requires company_name, domain, and category." };
    }
    if (competitors.length < 1 || competitors.length > 5) {
      return {
        success: false,
        error: `scan_ai_visibility needs 1-5 competitors as 'Name=domain' pairs (got ${competitors.length}).`,
      };
    }

    const surfaces = buildDefaultSurfaces();
    if (surfaces.length === 0) {
      return {
        success: false,
        error:
          "No AI surfaces configured — set GOOGLE_GENERATIVE_AI_API_KEY (google-ai) and/or OPENROUTER_API_KEY " +
          "(chatgpt/perplexity via GAP_SCAN_SURFACES).",
      };
    }

    try {
      const { report, insights, markdown } = await runGapScan(
        {
          target: { name: companyName, domain },
          competitors,
          category,
          ...(typeof args["runs_per_prompt"] === "number" ? { runsPerPrompt: args["runs_per_prompt"] } : {}),
          ...(typeof args["max_prompts"] === "number" ? { maxPrompts: args["max_prompts"] } : {}),
        },
        surfaces,
      );
      if (report.runs_completed === 0) {
        return {
          success: false,
          error: `All ${report.runs_total} surface calls failed (surfaces: ${report.surfaces.join(", ")}) — check API keys/quota and retry.`,
        };
      }
      const persistence = await persistScan(report, insights, markdown);
      log.info(
        {
          target: domain,
          gap_score: report.gap_score,
          confidence: insights.confidence.grade,
          completion: report.completion_rate,
          runs: report.runs_total,
          persisted: persistence.persisted,
        },
        "gap scan complete",
      );
      return {
        success: true,
        data: { gap_score: report.gap_score, markdown, report, insights, ...persistence },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
