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

// ── Answer-quality judge (ASYNC EVALUATOR — never a gate) ──────────────────────
//
// `judgeOutbound` above is a GUARD: inline, before a send, critique on a human
// approval card. Below is an EVALUATOR: it scores a reply the founder has ALREADY
// been given, off the reply path, recorded and never enforced. Same model, same
// temperature 0 — opposite failure direction, which is why it cannot share
// `parseJudgeVerdict`. A guard that can't read its judge must fail OPEN or it
// blocks the founder; an evaluator that fails open to a passing score makes "the
// judge was down" and "the answer was grounded" the same stored row. An unreadable
// verdict here is `not_evaluated` WITH the reason — `rag-optimization-sweep.ts`.

/** Score floor for every answer dimension (0 = the dimension completely failed). */
export const ANSWER_SCORE_MIN = 0;
/** Score ceiling for every answer dimension (100 = the dimension is fully met). */
export const ANSWER_SCORE_MAX = 100;
/** Per-step output chars shown to the judge — beyond this it is context bloat, not evidence. */
export const ANSWER_JUDGE_STEP_MAX_CHARS = 1_500;
/** Reply chars shown to the judge. A founder reply longer than this is already a defect. */
export const ANSWER_JUDGE_REPLY_MAX_CHARS = 4_000;

/** One executed plan step, narrowed to what the judge can actually reason about. */
export interface AnswerJudgeStep {
  readonly stepId: string;
  readonly objective: string;
  readonly status: "ok" | "failed";
  /** Serialized `StepResult.output` (ok) or the failure evidence (failed). */
  readonly output: string;
}

export interface AnswerJudgeInput {
  readonly goal: string;
  readonly reply: string;
  readonly steps: readonly AnswerJudgeStep[];
}

/**
 * The three dimensions, scored separately and never collapsed into one number.
 * groundedness = every factual claim is backed by a step result this turn produced;
 * relevance = the reply answers the planned goal; completeness = no planned step
 * was left unaddressed. `critique` names the weakest one ("" if the judge gave none).
 */
export interface AnswerScores {
  readonly groundedness: number;
  readonly relevance: number;
  readonly completeness: number;
  readonly critique: string;
}

/**
 * Either three real scores, or the reason there are none. Encoding the failure in
 * the return type is what makes it impossible for a caller to store an outage as
 * a passing evaluation.
 */
export type AnswerJudgement =
  | { readonly status: "evaluated"; readonly scores: AnswerScores }
  | { readonly status: "not_evaluated"; readonly reason: string };

/** `provider:model` actually in force — recorded beside each verdict so a model swap is visible. */
export function judgeModelLabel(): string {
  const { provider, model } = resolveJudgeModelId();
  return `${provider}:${model}`;
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function buildAnswerJudgePrompt(input: AnswerJudgeInput): string {
  const steps = input.steps.map(
    (s) => `- ${s.stepId} [${s.status}] objective: ${s.objective}\n  result: ${clamp(s.output, ANSWER_JUDGE_STEP_MAX_CHARS)}`,
  );
  return [
    "You are an independent evaluator of an AI assistant's answer, which a different",
    "model wrote. You are NOT a gate — it was already delivered, so grade honestly.",
    "",
    "Score three dimensions SEPARATELY, each an integer 0-100:",
    "  groundedness — is EVERY factual claim in the answer supported by a step result below?",
    "                 A claim with no supporting step result is the most serious defect here.",
    "  relevance    — does the answer address the stated goal?",
    "  completeness — was any planned step left unaddressed in the answer?",
    "",
    `GOAL: ${input.goal}`,
    "",
    steps.length > 0 ? `STEP RESULTS (the only ground truth):\n${steps.join("\n")}` : "STEP RESULTS: none were produced.",
    "",
    "ANSWER:",
    '"""',
    clamp(input.reply, ANSWER_JUDGE_REPLY_MAX_CHARS),
    '"""',
    "",
    'Reply with ONLY compact JSON: {"groundedness":<int>,"relevance":<int>,"completeness":<int>,',
    '"critique":"<one sentence naming the weakest dimension and why>"}.',
  ].join("\n");
}

/** Read one score field: must be a finite number inside the range, else the whole verdict is unusable. */
function readScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < ANSWER_SCORE_MIN || rounded > ANSWER_SCORE_MAX) return null;
  return rounded;
}

/**
 * Parse the answer judge's reply. Total, and FAIL-VISIBLE: anything short of three
 * in-range scores is `not_evaluated` with the reason — never a default score.
 */
export function parseAnswerJudgement(raw: string): AnswerJudgement {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { status: "not_evaluated", reason: "judge reply contained no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { status: "not_evaluated", reason: "judge reply was not valid JSON" };
  }
  const obj = parsed as Record<string, unknown>;
  const groundedness = readScore(obj["groundedness"]);
  const relevance = readScore(obj["relevance"]);
  const completeness = readScore(obj["completeness"]);
  const missing = ([["groundedness", groundedness], ["relevance", relevance], ["completeness", completeness]] as const)
    .filter(([, score]) => score === null)
    .map(([name]) => name);
  if (groundedness === null || relevance === null || completeness === null) {
    return {
      status: "not_evaluated",
      reason: `judge returned no usable score for: ${missing.join(", ")} (each must be an integer ${ANSWER_SCORE_MIN}-${ANSWER_SCORE_MAX})`,
    };
  }
  const critique = typeof obj["critique"] === "string" ? obj["critique"].trim() : "";
  return { status: "evaluated", scores: { groundedness, relevance, completeness, critique } };
}

const _answerCache = new Map<string, { judgement: AnswerJudgement; at: number }>();

/** Test seam: clear the answer-verdict memo so cases don't leak into each other. */
export function _resetAnswerJudgeCache(): void {
  _answerCache.clear();
}

/**
 * Score a reply the founder has already received. Runs on the SAME different-family,
 * temperature-0, free-tier judge as `judgeOutbound` — one model resolution path, one
 * cache shape, one set of provider keys.
 *
 * This function must never be awaited on the reply path; see `src/infra/answer-eval.ts`.
 */
export async function judgeAnswer(
  input: AnswerJudgeInput,
  opts: { model?: JudgeModel; now?: () => number } = {},
): Promise<AnswerJudgement> {
  const now = opts.now ?? Date.now;
  const injected = opts.model;

  if (!injected && !isJudgeEnabled()) {
    return {
      status: "not_evaluated",
      reason: `no API key configured for judge model ${judgeModelLabel()} — the turn was never scored`,
    };
  }

  const key = `answer:${hash(`${input.goal} ${input.reply}`)}`;
  const cached = _answerCache.get(key);
  if (cached && now() - cached.at < JUDGE_CACHE_TTL_MS) return cached.judgement;

  let judgement: AnswerJudgement;
  try {
    const model = injected ?? getJudgeModel();
    const res = await model.invoke(buildAnswerJudgePrompt(input));
    const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    judgement = parseAnswerJudgement(content);
  } catch (err) {
    judgement = { status: "not_evaluated", reason: `judge model call failed — ${(err as Error).message}` };
  }

  if (judgement.status === "not_evaluated") {
    // Loud, and NOT cached: a transient outage must not pin "unscored" for the whole TTL.
    log.warn({ reason: judgement.reason, model: judgeModelLabel() }, "Answer evaluation did not produce scores");
    return judgement;
  }
  _answerCache.set(key, { judgement, at: now() });
  return judgement;
}
