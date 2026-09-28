/**
 * The judge builds its own ChatGoogleGenerativeAI, outside the model factory.
 *
 * Prod runs JUDGE_MODEL=google-genai:gemini-3.1-flash-lite
 * (scripts/apply-prod-env-overrides.sh), so the Gemini thinking change in
 * src/agents/model.ts alone would have left the judge on default dynamic
 * thinking. The judge also caps maxOutputTokens at 512, and on Gemini 3.x the
 * thought tokens count against that cap — so default thinking can plausibly
 * starve the verdict. That starvation is NOT measured (the audit has no
 * no-thinking-config baseline for flash-lite); what is pinned here is only that
 * the judge sends the same level as every other google-genai model.
 *
 * JUDGE_MODEL is read when judge-model.ts loads, so each case sets it and then
 * imports a fresh copy of the module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = ["JUDGE_MODEL", "GEMINI_THINKING_LEVEL", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENROUTER_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-key";
  process.env["OPENROUTER_API_KEY"] = "sk-or-test-key-for-vitest";
  delete process.env["GEMINI_THINKING_LEVEL"];
  vi.resetModules();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function judgeFor(judgeModel: string): Promise<unknown> {
  process.env["JUDGE_MODEL"] = judgeModel;
  const { getJudgeModel } = await import("../../../src/infra/judge-model.js");
  return getJudgeModel();
}

const thinkingOf = (m: unknown): unknown => (m as { thinkingConfig?: unknown }).thinkingConfig;
const requestThinkingOf = (m: unknown): unknown =>
  (m as { client?: { generationConfig?: { thinkingConfig?: unknown } } }).client?.generationConfig?.thinkingConfig;

describe("getJudgeModel — thinking level", () => {
  it("sends LOW thinking from the prod google-genai judge, keeping its 512-token cap", async () => {
    const judge = await judgeFor("google-genai:gemini-3.1-flash-lite");
    expect(thinkingOf(judge)).toEqual({ thinkingLevel: "LOW" });
    expect(requestThinkingOf(judge)).toEqual({ thinkingLevel: "LOW" });
    expect((judge as { maxOutputTokens?: number }).maxOutputTokens).toBe(512);
  });

  it("follows GEMINI_THINKING_LEVEL like the model factory does", async () => {
    process.env["GEMINI_THINKING_LEVEL"] = "DEFAULT";
    const judge = await judgeFor("google-genai:gemini-3.1-flash-lite");
    expect(thinkingOf(judge)).toBeUndefined();
    expect(requestThinkingOf(judge)).toBeUndefined();
  });

  it("leaves an OpenRouter judge untouched", async () => {
    process.env["GEMINI_THINKING_LEVEL"] = "HIGH";
    const judge = await judgeFor("openrouter:nvidia/nemotron-3-super-120b-a12b:free");
    expect(thinkingOf(judge)).toBeUndefined();
    expect(JSON.stringify((judge as { invocationParams(): unknown }).invocationParams())).not.toMatch(/thinking/i);
  });
});
