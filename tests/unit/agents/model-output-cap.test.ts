/**
 * AG-050: every model FounderOS builds carries an explicit output cap, and no
 * production fallback list names a paid model.
 *
 * Without a cap OpenRouter reserves the model's full output window against the
 * balance, so a 402 arrived on 2026-10-08 with credit still on the key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFallbackModels, getModel } from "../../../src/agents/model.js";
import { _resetJudgeModel, getJudgeModel } from "../../../src/infra/judge-model.js";
import { estimateCost } from "../../../src/infra/budget-costs.js";

const KEYS = [
  "AGENT_MODEL", "AGENT_FALLBACK_MODELS", "MODEL_MAX_OUTPUT_TOKENS", "JUDGE_MODEL",
  "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
];
let saved: Record<string, string | undefined> = {};

/** The cap as each LangChain class stores it. */
function capOf(model: unknown): number | undefined {
  const m = model as { maxTokens?: number; maxOutputTokens?: number };
  return m.maxTokens ?? m.maxOutputTokens;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env["OPENROUTER_API_KEY"] = "test";
  process.env["ANTHROPIC_API_KEY"] = "test";
  process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test";
  process.env["OPENAI_API_KEY"] = "test";
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/does-not-need-to-exist-for-construction.json";
  process.env["GOOGLE_CLOUD_PROJECT"] = "test-project";
  delete process.env["MODEL_MAX_OUTPUT_TOKENS"];
  _resetJudgeModel();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetJudgeModel();
});

describe("MODEL_MAX_OUTPUT_TOKENS on every model", () => {
  const ids = [
    "openrouter:google/gemini-3.8-flash",
    "anthropic:claude-sonnet-5-5",
    "google-genai:gemini-3.8-flash",
    "google-vertexai:gemini-3.8-flash",
    "openai:gpt-5-mini",
    "omnirouter:some-model",
  ];

  it.each(ids)("primary %s defaults to 4096", (id) => {
    process.env["AGENT_MODEL"] = id;
    expect(capOf(getModel())).toBe(4096);
  });

  it("honours an override", () => {
    process.env["AGENT_MODEL"] = "openrouter:google/gemini-3.8-flash";
    process.env["MODEL_MAX_OUTPUT_TOKENS"] = "2048";
    expect(capOf(getModel())).toBe(2048);
  });

  it("caps every fallback model", () => {
    process.env["AGENT_FALLBACK_MODELS"] = ids.join(",");
    const fallbacks = buildFallbackModels();
    expect(fallbacks).toHaveLength(ids.length);
    for (const m of fallbacks) expect(capOf(m)).toBe(4096);
  });

  it.each(["openrouter:google/gemini-3.1-flash-lite", "google-vertexai:gemini-3.1-flash-lite"])(
    "the judge %s never exceeds the cap",
    (id) => {
      process.env["JUDGE_MODEL"] = id;
      process.env["MODEL_MAX_OUTPUT_TOKENS"] = "1024";
      const cap = capOf(getJudgeModel());
      expect(cap).toBeDefined();
      expect(cap).toBeLessThanOrEqual(1024);
    },
  );
});

describe("apply-prod-env-overrides.sh fallback lists", () => {
  const script = readFileSync(join(process.cwd(), "scripts/apply-prod-env-overrides.sh"), "utf8");
  const active = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  const lists = active
    .map((l) => /'(AGENT|WORKER|PLANNER)_FALLBACK_MODELS=([^']*)'/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);

  it("sets all three lists", () => {
    expect(lists.map((m) => m[1]).sort()).toEqual(["AGENT", "PLANNER", "WORKER"]);
  });

  it("names only :free slugs", () => {
    for (const m of lists) {
      for (const slug of (m[2] ?? "").split(",").filter(Boolean)) expect(slug, m[0]).toMatch(/:free$/);
    }
  });

  it("never names jev-router", () => {
    expect(active.join("\n")).not.toMatch(/jev-router/);
  });
});

describe("cost ledger prices", () => {
  it("prices a :free slug at zero, even when a paid twin exists", () => {
    expect(estimateCost(1_000_000, 1_000_000, "nvidia/nemotron-3-super-120b-a12b:free")).toBe(0);
    expect(estimateCost(1_000_000, 1_000_000, "openrouter:nvidia/nemotron-3-super-120b-a12b:free")).toBe(0);
  });

  it("prices the new defaults from the provider's table, not the fallback default", () => {
    expect(estimateCost(1_000_000, 1_000_000, "google/gemini-3.1-flash-lite")).toBeCloseTo(1.75, 6);
    expect(estimateCost(1_000_000, 1_000_000, "deepseek/deepseek-v4-flash")).toBeCloseTo(1.2931, 6);
  });
});
