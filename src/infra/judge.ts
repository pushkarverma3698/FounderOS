/**
 * FounderOS — independent critic / judge (Phase 3)
 * ================================================
 * Generator≠critic (CLAUDE rule #6). The drafting agents run on Gemini; this
 * judge runs on a DIFFERENT model family (default: a FREE OpenRouter Llama-70b,
 * configurable via JUDGE_MODEL — Anthropic still supported), so the critic
 * cannot rubber-stamp its own generation (sycophancy guard) and costs $0 per
 * draft. It is **gate 2** for outbound copy, after the deterministic
 * `brand-validator` (gate 1) passes.
 *
 * Fail-open by design: ANY failure (no API key, model error, unparseable
 * output, or a 'revise' with no actionable critique) returns `pass`. HITL is the
 * final human gate (rule #4) — the judge must never silently block the founder's
 * workflow on its own confusion. It can only *add* a critique to the approval card.
 *
 * Determinism (rule #16): judge temperature is 0; the verdict is parsed by a
 * pure function with a unit test, not trusted as free-form prose.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import type { Channel } from "./brand-validator.js";
import { childLogger } from "./logger.js";

/** Judge providers we support. Kept local so infra/ doesn't depend on agents/. */
type JudgeProvider = "anthropic" | "openrouter" | "openai" | "google-genai";

const log = childLogger({ module: "judge" });

export type JudgeVerdict = { verdict: "pass" } | { verdict: "revise"; critique: string };

/** Minimal model surface so tests can inject a fake (no network). */
export interface JudgeModel {
  invoke(messages: unknown): Promise<{ content: unknown }>;
}

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
/** Memoize a verdict for this long so the interrupt() re-execution is a cache hit. */
const JUDGE_CACHE_TTL_MS = 5 * 60_000;

/** Resolve the judge model id, defaulting a bare id to the OpenRouter free tier. */
function resolveJudgeModelId(): { provider: JudgeProvider; model: string } {
  const raw = JUDGE_MODEL.includes(":") ? JUDGE_MODEL : `openrouter:${JUDGE_MODEL}`;
  const sep = raw.indexOf(":");
  const provider = raw.slice(0, sep) as JudgeProvider;
  const model = raw.slice(sep + 1).trim();
  const valid: JudgeProvider[] = ["anthropic", "openrouter", "openai", "google-genai"];
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
    default:
      return false;
  }
}

let _model: BaseChatModel | undefined;
function getJudgeModel(): BaseChatModel {
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
    } else {
      // openai / google-genai judges are uncommon; route via the standard OpenAI client.
      _model = new ChatOpenAI({ model, temperature: 0, maxTokens: 512, maxRetries: 2 });
    }
  }
  return _model;
}

/** Test seam: drop the memoized model so a JUDGE_MODEL change is picked up. */
export function _resetJudgeModel(): void {
  _model = undefined;
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

function buildJudgePrompt(text: string, channel: Channel): string {
  return [
    "You are a senior brand editor for Turicks, an AI agency. You are the SECOND,",
    "independent reviewer of outbound copy (a different model already drafted it).",
    "Judge ONLY: is this ready to send as-is to a real prospect/audience?",
    "Flag: hype/buzzwords, generic AI-slop phrasing, factual overreach, wrong tone,",
    "or anything that would embarrass the founder. Be strict but practical — minor",
    "stylistic nitpicks are a PASS.",
    "",
    `CHANNEL: ${channel}`,
    "DRAFT:",
    '"""',
    text,
    '"""',
    "",
    'Reply with ONLY compact JSON. Either {"verdict":"pass"} or',
    '{"verdict":"revise","critique":"<one concrete, actionable fix>"}.',
  ].join("\n");
}

// ── Pure verdict parser (fail-open) ─────────────────────────────────────────────

/**
 * Parse the judge's reply into a verdict. Total + fail-open: anything we can't
 * confidently read as a `revise` with an actionable critique becomes `pass`.
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "pass" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { verdict: "pass" };
  }
  const obj = parsed as { verdict?: unknown; critique?: unknown };
  if (obj.verdict !== "revise") return { verdict: "pass" };
  const critique = typeof obj.critique === "string" ? obj.critique.trim() : "";
  // A 'revise' with no actionable critique is useless — degrade to pass.
  return critique ? { verdict: "revise", critique } : { verdict: "pass" };
}

// ── Verdict cache (TTL) ─────────────────────────────────────────────────────────

const _cache = new Map<string, { verdict: JudgeVerdict; at: number }>();

/** djb2 string hash — stable, collision-tolerant enough for a short-TTL memo key. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Test seam: clear the memo so cases don't leak into each other. */
export function _resetJudgeCache(): void {
  _cache.clear();
}

// ── Public judge ─────────────────────────────────────────────────────────────────

/**
 * Judge an outbound draft. Returns `pass` to proceed to HITL as-is, or `revise`
 * with a critique to surface on the approval card. Memoized by (channel, tool, text)
 * within a TTL so the HITL interrupt re-execution doesn't fire a second Claude call.
 *
 * §11 fix: cache key includes tool_name so identical copy for different tools
 * (e.g. linkedin_post vs send_email) can't share a cached verdict from the wrong context.
 */
export async function judgeOutbound(
  text: string,
  channel: Channel,
  opts: { model?: JudgeModel; now?: () => number; tool?: string } = {},
): Promise<JudgeVerdict> {
  const now = opts.now ?? Date.now;
  const injected = opts.model;

  // No model configured and none injected → gate 2 is a no-op (fail-open pass).
  if (!injected && !isJudgeEnabled()) return { verdict: "pass" };

  const toolTag = opts.tool ?? "unknown";
  const key = `${channel}:${toolTag}:${hash(text)}`;
  const cached = _cache.get(key);
  if (cached && now() - cached.at < JUDGE_CACHE_TTL_MS) return cached.verdict;

  let verdict: JudgeVerdict;
  try {
    const model = injected ?? getJudgeModel();
    const res = await model.invoke(buildJudgePrompt(text, channel));
    const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    verdict = parseJudgeVerdict(content);
  } catch (err) {
    // Infra failure must never block the founder — HITL still gates the send.
    log.warn({ err: (err as Error).message, channel }, "Judge errored — failing open to pass");
    verdict = { verdict: "pass" };
  }

  _cache.set(key, { verdict, at: now() });
  return verdict;
}
