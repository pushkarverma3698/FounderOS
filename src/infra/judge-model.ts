/**
 * FounderOS — judge model resolution
 * ==================================
 * Split out of `judge.ts` (2026-08-27) so the judging logic and the provider
 * wiring are separate concerns — and so adding a provider can't push judge.ts
 * over the 400-line budget the architecture ratchet enforces.
 *
 * One rule governs this file: every provider the validator ACCEPTS must be
 * CONSTRUCTED here. They previously disagreed — `google-genai` passed
 * validation, then fell through to a keyless OpenAI client and failed with
 * "Missing credentials … OPENAI_API_KEY". Because the judge is fail-open, that
 * surfaced as silently-missing scores rather than an error.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { ChatOpenAI } from "@langchain/openai";

/** Judge providers we support. Kept local so infra/ doesn't depend on agents/. */
export type JudgeProvider = "anthropic" | "openrouter" | "openai" | "google-genai" | "google-vertexai";

/**
 * Critic model id. Override with JUDGE_MODEL. Default = a FREE OpenRouter model
 * from a DIFFERENT family than the Gemini drafter (rule #6 anti-sycophancy) so
 * the critic can't rubber-stamp its own generation — and costs $0 (no paid
 * Anthropic call on every outbound draft). Llama-3.3-70b follows the compact-JSON
 * instruction reliably; deepseek-r1:free also works but is chattier.
 * Accepts a provider-prefixed id (openrouter:/anthropic:/openai:/google-genai:);
 * a bare id is treated as OpenRouter for free-tier convenience.
 */
const JUDGE_MODEL =
  process.env["JUDGE_MODEL"]?.trim() || "openrouter:meta-llama/llama-3.3-70b-instruct:free";

/** Resolve the judge model id, defaulting a bare id to the OpenRouter free tier. */
export function resolveJudgeModelId(): { provider: JudgeProvider; model: string } {
  const raw = JUDGE_MODEL.includes(":") ? JUDGE_MODEL : `openrouter:${JUDGE_MODEL}`;
  const sep = raw.indexOf(":");
  const provider = raw.slice(0, sep) as JudgeProvider;
  const model = raw.slice(sep + 1).trim();
  const valid: JudgeProvider[] = ["anthropic", "openrouter", "openai", "google-genai", "google-vertexai"];
  if (!valid.includes(provider) || !model) {
    // Unrecognized override → safe default (free OpenRouter Llama).
    return { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" };
  }
  return { provider, model };
}

/** True if the configured judge provider has its API key set (else gate 2 = no-op pass). */
export function isJudgeEnabled(): boolean {
  const { provider } = resolveJudgeModelId();
  switch (provider) {
    case "anthropic":
      return Boolean(process.env["ANTHROPIC_API_KEY"]);
    case "openrouter":
      return Boolean(process.env["OPENROUTER_API_KEY"]);
    case "openai":
      return Boolean(process.env["OPENAI_API_KEY"]);
    case "google-genai":
      return Boolean(process.env["GOOGLE_GENERATIVE_AI_API_KEY"]);
    case "google-vertexai":
      return Boolean(process.env["GOOGLE_APPLICATION_CREDENTIALS"]) && Boolean(process.env["GOOGLE_CLOUD_PROJECT"]);
    default:
      return false;
  }
}

let _model: BaseChatModel | undefined;
export function getJudgeModel(): BaseChatModel {
  if (!_model) {
    const { provider, model } = resolveJudgeModelId();
    if (provider === "anthropic") {
      _model = new ChatAnthropic({ model, temperature: 0, maxTokens: 512 });
    } else if (provider === "openrouter") {
      _model = new ChatOpenAI({
        model,
        temperature: 0,
        maxTokens: 512,
        maxRetries: 2,
        apiKey: process.env["OPENROUTER_API_KEY"] || "missing-openrouter-key",
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
      });
    } else if (provider === "google-genai") {
      _model = new ChatGoogleGenerativeAI({
        model,
        temperature: 0,
        maxOutputTokens: 512,
        maxRetries: 2,
        apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
      });
    } else if (provider === "google-vertexai") {
      _model = new ChatVertexAI({
        model,
        temperature: 0,
        maxRetries: 2,
        authOptions: {
          keyFilename: process.env["GOOGLE_APPLICATION_CREDENTIALS"],
          projectId: process.env["GOOGLE_CLOUD_PROJECT"],
        },
        location: process.env["GOOGLE_CLOUD_LOCATION"]?.trim() || "us-central1",
      });
    } else {
      // openai judges route via the standard OpenAI client.
      _model = new ChatOpenAI({ model, temperature: 0, maxTokens: 512, maxRetries: 2 });
    }
  }
  return _model;
}

/** Test seam: drop the memoized model so a JUDGE_MODEL change is picked up. */
export function _resetJudgeModel(): void {
  _model = undefined;
}
