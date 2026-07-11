/**
 * Gap Scanner tool — full pipeline with SCRIPTED surfaces ($0, offline):
 * runGapScan → aggregate → render, plus the UnifiedTool envelope (arg
 * validation, soft failure, no-surfaces guard) and the pure parsers.
 * Production surface adapters are exercised against a mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Persistence boundary — the real module pulls the DB client (and full env
// validation); the tool's dynamic import resolves to this mock instead.
const mockSaveGapScan = vi.fn(async () => "scan-uuid-1");
vi.mock("../../../src/db/gap-scan-queries.js", () => ({ saveGapScan: mockSaveGapScan }));

const {
  gapScannerTool,
  runGapScan,
  parseCompetitors,
  parseSurfaceSpec,
  buildDefaultSurfaces,
  geminiSurface,
  openrouterSurface,
} = await import("../../../src/tools/gap-scanner.js");
type Surface = import("../../../src/tools/gap-scanner.js").Surface;

const NOW = () => new Date("2026-07-11T12:00:00.000Z");

/** A deterministic surface: same scripted answer for every prompt. */
function scriptedSurface(id: string, answer: string): Surface {
  return { id, ask: async () => ({ ok: true, answer }) };
}

function failingSurface(id: string): Surface {
  return { id, ask: async () => ({ ok: false, error: `${id} HTTP 503` }) };
}

const CONFIG = {
  target: { name: "Acme", domain: "acme.com" },
  competitors: [
    { name: "HubSpot", domain: "hubspot.com" },
    { name: "Close", domain: "close.com" },
  ],
  category: "CRM",
  runsPerPrompt: 2,
  maxPrompts: 5,
  year: 2026,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  delete process.env["OPENROUTER_API_KEY"];
  delete process.env["GAP_SCAN_SURFACES"];
});

// ── runGapScan (the offline e2e) ──────────────────────────────────────────────

describe("runGapScan", () => {
  it("samples prompts × surfaces × N and produces a full report + insights + markdown", async () => {
    const { report, insights, markdown } = await runGapScan(
      CONFIG,
      [
        scriptedSurface("chatgpt", "HubSpot (hubspot.com) and Close lead the CRM space."),
        scriptedSurface("perplexity", "Close is popular; HubSpot too."),
      ],
      NOW,
    );

    // 5 prompts × 2 surfaces × 2 runs
    expect(report.runs_total).toBe(20);
    expect(report.runs_completed).toBe(20);
    expect(report.completion_rate).toBe(1);
    expect(report.surfaces).toEqual(["chatgpt", "perplexity"]);
    expect(report.generated_at).toBe("2026-07-11T12:00:00.000Z");

    // Target invisible everywhere, competitors everywhere → maximal gap.
    expect(report.gap_score).toBe(100);
    expect(report.companies[0]!.appearance_rate).toBe(0);
    expect(report.causes.length).toBeGreaterThan(0);
    expect(report.evidence.length).toBeGreaterThan(0);

    // The multi-angle insights ride along with the report.
    expect(insights.stake.lost_answers).toBe(20); // competitors in every answer, target in none
    expect(insights.threats[0]!.threat).toBe("primary");
    expect(insights.confidence.grade).toBe("medium"); // 20 runs but runsPerPrompt 2 < 3

    // The 1-pager carries the sections the spec fixes, plus the insight angles.
    expect(markdown).toContain("# AI Visibility Gap Report — Acme");
    expect(markdown).toContain("Gap Score: 100/100");
    expect(markdown).toContain("| **Acme** (you) | 0% |");
    expect(markdown).toContain("## Where the funnel leaks (by buyer intent)");
    expect(markdown).toContain("## Competitor threat profile");
    expect(markdown).toContain("## Top diagnosed causes");
    expect(markdown).toContain("## Confidence: MEDIUM");
    expect(markdown).toContain("Methodology:");
    expect(markdown).toContain("20 sampled answers");
  });

  it("keeps counting when one surface fails entirely (fail-soft, honest completion rate)", async () => {
    const { report } = await runGapScan(
      CONFIG,
      [scriptedSurface("chatgpt", "Acme (acme.com) is the leader."), failingSurface("perplexity")],
      NOW,
    );
    expect(report.runs_total).toBe(20);
    expect(report.runs_completed).toBe(10);
    expect(report.completion_rate).toBe(0.5);
    // Rates come from COMPLETED runs only.
    expect(report.companies[0]!.appearance_rate).toBe(1);
    expect(report.gap_score).toBe(0);
  });

  it("clamps runsPerPrompt to the 1–5 band", async () => {
    const { report } = await runGapScan(
      { ...CONFIG, runsPerPrompt: 99, maxPrompts: 2 },
      [scriptedSurface("chatgpt", "x")],
      NOW,
    );
    expect(report.runs_per_prompt).toBe(5);
    expect(report.runs_total).toBe(10); // 2 prompts × 1 surface × 5
  });
});

// ── Pure parsers ──────────────────────────────────────────────────────────────

describe("parseCompetitors", () => {
  it("parses Name=domain pairs with whitespace tolerance", () => {
    expect(parseCompetitors(" HubSpot = hubspot.com , Close=close.com ")).toEqual([
      { name: "HubSpot", domain: "hubspot.com" },
      { name: "Close", domain: "close.com" },
    ]);
  });

  it("drops malformed pairs instead of throwing", () => {
    expect(parseCompetitors("bad-pair, =nodomain.com, Good=good.com,")).toEqual([
      { name: "Good", domain: "good.com" },
    ]);
  });
});

describe("parseSurfaceSpec / buildDefaultSurfaces", () => {
  it("parses the id=model spec", () => {
    expect(parseSurfaceSpec("chatgpt=openai/gpt-4o-mini, perplexity=perplexity/sonar")).toEqual([
      { id: "chatgpt", model: "openai/gpt-4o-mini" },
      { id: "perplexity", model: "perplexity/sonar" },
    ]);
  });

  it("returns no surfaces when no API keys are configured", () => {
    expect(buildDefaultSurfaces({})).toEqual([]);
  });

  it("builds google-ai from the Gemini key and OpenRouter surfaces from the spec", () => {
    const surfaces = buildDefaultSurfaces({
      GOOGLE_GENERATIVE_AI_API_KEY: "g-key",
      OPENROUTER_API_KEY: "or-key",
      GAP_SCAN_SURFACES: "chatgpt=openai/gpt-4o-mini",
    });
    expect(surfaces.map((s) => s.id)).toEqual(["google-ai", "chatgpt"]);
  });

  it("defaults OpenRouter surfaces to chatgpt + perplexity", () => {
    const surfaces = buildDefaultSurfaces({ OPENROUTER_API_KEY: "or-key" });
    expect(surfaces.map((s) => s.id)).toEqual(["chatgpt", "perplexity"]);
  });
});

// ── Production surface adapters (mocked fetch) ────────────────────────────────

describe("surface adapters", () => {
  it("geminiSurface extracts the grounded answer text", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "HubSpot leads." }] } }] }),
    });
    const res = await geminiSurface("g-key").ask("best CRM");
    expect(res).toEqual({ ok: true, answer: "HubSpot leads." });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    expect(init.body as string).toContain("google_search");
  });

  it("geminiSurface soft-fails on HTTP errors and empty answers", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    expect(await geminiSurface("k").ask("q")).toEqual({ ok: false, error: "gemini HTTP 503" });

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    const empty = await geminiSurface("k").ask("q");
    expect(empty.ok).toBe(false);
  });

  it("openrouterSurface posts the prompt and extracts the completion", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Close is great." } }] }),
    });
    const res = await openrouterSurface("perplexity", "perplexity/sonar", "or-key").ask("best CRM");
    expect(res).toEqual({ ok: true, answer: "Close is great." });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain("openrouter.ai");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer or-key");
    expect(JSON.parse(init.body as string).model).toBe("perplexity/sonar");
  });

  it("openrouterSurface soft-fails on a thrown network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
    const res = await openrouterSurface("chatgpt", "openai/gpt-4o-mini", "k").ask("q");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("ECONNRESET");
  });
});

// ── UnifiedTool envelope ──────────────────────────────────────────────────────

describe("gapScannerTool.execute", () => {
  const ARGS = {
    company_name: "Acme",
    domain: "acme.com",
    category: "CRM",
    competitors: "HubSpot=hubspot.com, Close=close.com",
    runs_per_prompt: 1,
    max_prompts: 2,
  };

  it("soft-fails when required args are missing", async () => {
    const res = await gapScannerTool.execute({ company_name: "Acme" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("requires");
  });

  it("soft-fails on 0 or >5 competitors", async () => {
    const none = await gapScannerTool.execute({ ...ARGS, competitors: "" });
    expect(none.success).toBe(false);
    expect(none.error).toContain("1-5 competitors");

    const six = Array.from({ length: 6 }, (_, i) => `C${i}=c${i}.com`).join(",");
    const many = await gapScannerTool.execute({ ...ARGS, competitors: six });
    expect(many.success).toBe(false);
  });

  it("soft-fails with a setup hint when no surfaces are configured", async () => {
    const res = await gapScannerTool.execute(ARGS);
    expect(res.success).toBe(false);
    expect(res.error).toContain("No AI surfaces configured");
  });

  it("runs the scan, persists it to gap_scans, and returns gap_score + markdown + report + insights", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["GAP_SCAN_SURFACES"] = "chatgpt=openai/gpt-4o-mini";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "HubSpot (hubspot.com) dominates." } }] }),
    });

    const res = await gapScannerTool.execute(ARGS);
    expect(res.success).toBe(true);
    const data = res.data as {
      gap_score: number;
      markdown: string;
      report: { runs_total: number };
      insights: { confidence: { grade: string } };
      persisted: boolean;
      scan_id: string;
    };
    expect(data.gap_score).toBe(100);
    expect(data.markdown).toContain("AI Visibility Gap Report — Acme");
    expect(data.report.runs_total).toBe(2); // 2 prompts × 1 surface × 1 run
    expect(data.insights.confidence.grade).toBe("low"); // 2 answers is a tiny sample

    // Persisted with the hot columns broken out for indexed retrieval.
    expect(data).toMatchObject({ persisted: true, scan_id: "scan-uuid-1" });
    expect(mockSaveGapScan).toHaveBeenCalledWith(
      expect.objectContaining({
        target_name: "Acme",
        target_domain: "acme.com",
        category: "CRM",
        gap_score: 100,
        confidence: "low",
        runs_total: 2,
        surfaces: ["chatgpt"],
        markdown: expect.stringContaining("AI Visibility Gap Report"),
        report: expect.objectContaining({ gap_score: 100 }),
        insights: expect.objectContaining({ confidence: expect.anything() }),
      }),
    );
  });

  it("surfaces a DB failure honestly (persist_error) without voiding the scan", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["GAP_SCAN_SURFACES"] = "chatgpt=openai/gpt-4o-mini";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "HubSpot wins." } }] }),
    });
    mockSaveGapScan.mockRejectedValueOnce(new Error("connection refused"));

    const res = await gapScannerTool.execute(ARGS);
    expect(res.success).toBe(true); // the report exists — persistence failure never voids it
    expect(res.data).toMatchObject({ persisted: false, persist_error: "connection refused" });
  });

  it("reports not-saved when DATABASE_URL is not configured", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["GAP_SCAN_SURFACES"] = "chatgpt=openai/gpt-4o-mini";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "HubSpot wins." } }] }),
    });

    const saved = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      const res = await gapScannerTool.execute(ARGS);
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({ persisted: false, persist_error: expect.stringContaining("DATABASE_URL") });
      expect(mockSaveGapScan).not.toHaveBeenCalled();
    } finally {
      process.env["DATABASE_URL"] = saved!;
    }
  });

  it("soft-fails (never throws) when every surface call fails", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["GAP_SCAN_SURFACES"] = "chatgpt=openai/gpt-4o-mini";
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const res = await gapScannerTool.execute(ARGS);
    expect(res.success).toBe(false);
    expect(res.error).toContain("surface calls failed");
  });
});

afterEach(() => {
  delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  delete process.env["OPENROUTER_API_KEY"];
  delete process.env["GAP_SCAN_SURFACES"];
});
