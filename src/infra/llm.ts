/**
 * FounderOS — LLM Provider Cascade (native fetch edition)
 * =========================================================
 * Zero LangChain provider dependencies — all API calls are plain fetch.
 * Only @langchain/core (BaseMessage types) is retained because LangGraph
 * state passes BaseMessage[] natively and we never want two message formats.
 *
 * Architecture:
 *  1. Provider cascade — tries entries in order, stops on first success
 *  2. Circuit breaker per provider (opossum) — trips after 3 failures, resets after 5 min
 *  3. Global rate limiter (bottleneck) — max 5 concurrent, 200ms between requests
 *  4. Cost recording — writes to llm_costs after every successful call
 *
 * Two execution patterns (Phase 3 — two-phase LLM):
 *   runPlanner(tier, messages, opts)    — cloud LLM, structured JSON plan
 *   callCascade(tier, messages, opts)   — general cascade call (used by all agents)
 *
 * Why native fetch over LangChain provider packages:
 *   Removes @langchain/anthropic, @langchain/google-genai, @langchain/openai,
 *   @langchain/community — four packages, ~30 MB of transitive deps, no
 *   BaseChatModel casting (was 8x `as unknown as BaseChatModel`).
 *   The provider APIs are stable REST APIs; we don't need an abstraction layer.
 *
 * Usage:
 *   const result = await callCascade("md", messages, { agent: "bdr" });
 *   const plan   = await runPlanner("ceo", messages, { agent: "supervisor" });
 */

import type { BaseMessage } from "@langchain/core/messages";
import CircuitBreaker from "opossum";
import Bottleneck from "bottleneck";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import {
  CASCADE,
  CIRCUIT_BREAKER_OPTIONS,
  env,
  MODEL_COST_PER_1M,
  RATE_LIMITER_OPTIONS,
  TIER_MAX_TOKENS,
  type CascadeEntry,
} from "../core/config.js";
import type { CascadeTier } from "../core/registry.js";
import { logLlmCost } from "../db/queries.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "llm" });

// ── Message format conversion ─────────────────────────────────────────────────

/** Normalised chat message for all OpenAI-compatible and Anthropic calls. */
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Convert LangGraph BaseMessage[] → plain chat array usable by every provider. */
function toMessages(messages: BaseMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const type = m._getType();
    // Content can be a string or an array of content blocks
    const content =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ text?: string; type?: string }>)
            .map((c) => c.text ?? "")
            .join("");

    if (type === "system") return { role: "system" as const, content };
    if (type === "ai") return { role: "assistant" as const, content };
    return { role: "user" as const, content };
  });
}

// ── Provider Implementations ──────────────────────────────────────────────────

type LLMResult = { text: string; tokensIn: number; tokensOut: number };

// ── Anthropic ──────────────────────────────────────────────────────────────────
// Docs: https://docs.anthropic.com/en/api/messages

type AnthropicContent = { type: string; text: string };
type AnthropicResponse = {
  content: AnthropicContent[];
  usage: { input_tokens: number; output_tokens: number };
  error?: { type: string; message: string };
};

async function callAnthropic(
  entry: CascadeEntry,
  msgs: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<LLMResult> {
  const systemMsg = msgs.find((m) => m.role === "system");
  const chatMsgs  = msgs.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model: entry.modelId,
    max_tokens: maxTokens,
    temperature,
    messages: chatMsgs,
  };
  if (systemMsg) body["system"] = systemMsg.content;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as AnthropicResponse;
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${data.error?.message ?? res.statusText}`);
  }

  const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  return { text, tokensIn: data.usage.input_tokens, tokensOut: data.usage.output_tokens };
}

// ── Google Generative AI ───────────────────────────────────────────────────────
// Docs: https://ai.google.dev/api/generate-content

type GooglePart    = { text: string };
type GoogleContent = { role: string; parts: GooglePart[] };
type GoogleResponse = {
  candidates?: Array<{ content: { parts: GooglePart[] } }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  error?: { code: number; message: string };
};

async function callGoogle(
  entry: CascadeEntry,
  msgs: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<LLMResult> {
  const systemMsg = msgs.find((m) => m.role === "system");
  const chatMsgs  = msgs.filter((m) => m.role !== "system");

  const contents: GoogleContent[] = chatMsgs.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemMsg) {
    body["systemInstruction"] = { parts: [{ text: systemMsg.content }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${entry.modelId}:generateContent?key=${env.GOOGLE_GENERATIVE_AI_API_KEY}`;
  const res  = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as GoogleResponse;
  if (!res.ok) {
    throw new Error(`Google ${res.status}: ${data.error?.message ?? res.statusText}`);
  }

  const text     = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  const tokensIn  = data.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, tokensIn, tokensOut };
}

// ── OpenAI-compatible (OpenAI · OpenRouter · LM Studio · Ollama) ──────────────
// One implementation covers all OpenAI-compatible REST APIs.

type OpenAIChoice   = { message: { content: string | null } };
type OpenAIUsage    = { prompt_tokens: number; completion_tokens: number };
type OpenAIResponse = { choices?: OpenAIChoice[]; usage?: OpenAIUsage; error?: { message: string } };

async function callOpenAICompat(
  entry: CascadeEntry,
  msgs: ChatMessage[],
  maxTokens: number,
  temperature: number,
  baseURL: string,
  apiKey: string,
  /** Pass true for Ollama/LM Studio to enable grammar-constrained JSON sampling. */
  jsonMode = false,
): Promise<LLMResult> {
  const bodyObj: Record<string, unknown> = {
    model: entry.modelId,
    max_tokens: maxTokens,
    temperature,
    messages: msgs,
  };
  // Ollama grammar-constrained JSON mode — prevents markdown-wrapped responses
  if (jsonMode) bodyObj["response_format"] = { type: "json_object" };

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });

  const data = (await res.json()) as OpenAIResponse;
  if (!res.ok) {
    throw new Error(`OpenAI-compat ${res.status}: ${data.error?.message ?? res.statusText}`);
  }

  return {
    text: data.choices?.[0]?.message?.content ?? "",
    tokensIn:  data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  };
}

// ── Core LLM Call ─────────────────────────────────────────────────────────────

/** Dispatch to the correct provider. Temperature 0.1 for local models, 0.3 otherwise. */
function callEntry(
  entry: CascadeEntry,
  messages: BaseMessage[],
  maxTokens: number,
): Promise<LLMResult> {
  const msgs = toMessages(messages);
  const temp = entry.provider === "lmstudio" ? 0.1 : 0.3;

  switch (entry.provider) {
    case "anthropic":
      return callAnthropic(entry, msgs, maxTokens, temp);

    case "google":
      return callGoogle(entry, msgs, maxTokens, temp);

    case "openai":
      return callOpenAICompat(entry, msgs, maxTokens, temp, "https://api.openai.com/v1", env.OPENAI_API_KEY ?? "");

    case "openrouter":
      return callOpenAICompat(entry, msgs, maxTokens, temp, "https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY ?? "");

    case "lmstudio":
      // Covers LM Studio AND Ollama (both expose /v1/chat/completions)
      // jsonMode=true: grammar-constrained JSON sampling prevents markdown-wrapped output
      return callOpenAICompat(entry, msgs, maxTokens, 0.1, `${env.LM_STUDIO_URL}/v1`, "lm-studio", true);
  }
}

// ── Rate Limiters (per provider category) ────────────────────────────────────
//
// Cloud (Anthropic, Google, OpenRouter, OpenAI): 5 concurrent, 200ms spacing
// Local (Ollama / LM Studio): 1 concurrent, 500ms spacing
// Reason: Ollama is single-threaded — queuing >1 request causes OOM + timeout
//         cascades that trip circuit breakers and waste cloud quota.

const cloudLimiter = new Bottleneck({
  maxConcurrent: RATE_LIMITER_OPTIONS.maxConcurrent, // 5
  minTime: RATE_LIMITER_OPTIONS.minTime,             // 200ms
});

const localLimiter = new Bottleneck({
  maxConcurrent: 1,   // Ollama single-threaded: never queue more than 1
  minTime: 500,       // 500ms between local calls to avoid OOM
});

/** Select the right rate limiter for a given provider. */
function getLimiter(provider: string): Bottleneck {
  return provider === "lmstudio" ? localLimiter : cloudLimiter;
}

// ── Circuit Breakers (per provider:model) ─────────────────────────────────────

type BreakerResult = LLMResult;
type BreakerAction = (
  entry: CascadeEntry,
  messages: BaseMessage[],
  maxTokens: number,
) => Promise<BreakerResult>;

const breakers = new Map<string, CircuitBreaker<Parameters<BreakerAction>, BreakerResult>>();

function getBreaker(key: string): CircuitBreaker<Parameters<BreakerAction>, BreakerResult> {
  if (!breakers.has(key)) {
    const breaker = new CircuitBreaker<Parameters<BreakerAction>, BreakerResult>(
      (entry, msgs, maxTok) => callEntry(entry, msgs, maxTok),
      CIRCUIT_BREAKER_OPTIONS,
    );

    breaker.on("open",     () => log.warn({ model: key }, "Circuit breaker OPEN — skipping provider"));
    breaker.on("halfOpen", () => log.info({ model: key }, "Circuit breaker half-open — testing"));
    breaker.on("close",    () => log.info({ model: key }, "Circuit breaker CLOSED — provider recovered"));

    breakers.set(key, breaker);
  }
  return breakers.get(key)!;
}

/** Check if a provider's circuit breaker is currently open. */
export function isBreakerOpen(providerModelKey: string): boolean {
  return breakers.get(providerModelKey)?.opened ?? false;
}

// ── Cascade Executor ──────────────────────────────────────────────────────────

export interface CascadeCallOpts {
  /** Agent name for cost tracking and logging. */
  agent: string;
  /** Tenant for cost tracking. */
  tenant_id?: string;
  /** Override max tokens for this call. Falls back to TIER_MAX_TOKENS[tier]. */
  maxTokens?: number;
  /** Lead ID for per-lead cost attribution (Phase 2). */
  lead_id?: string;
}

export interface CascadeResult {
  text: string;
  model: string;
  provider: string;
  tier: CascadeTier;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Returns true if the given provider has an API key configured in env.
 * lmstudio uses a fixed bearer token and never needs a real key.
 */
function hasProviderKey(provider: CascadeEntry["provider"]): boolean {
  switch (provider) {
    case "anthropic":  return !!env.ANTHROPIC_API_KEY;
    case "google":     return !!env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "openai":     return !!env.OPENAI_API_KEY;
    case "openrouter": return !!env.OPENROUTER_API_KEY;
    case "lmstudio":   return true; // no real key required
    default:           return false;
  }
}

/**
 * Call the LLM cascade for a tier.
 * Tries each entry in order, records cost, returns first success.
 * Skips providers whose API key is absent (avoids wasted 401 calls).
 * Throws AggregateError if ALL entries fail.
 */
export async function callCascade(
  tier: CascadeTier,
  messages: BaseMessage[],
  opts: CascadeCallOpts,
): Promise<CascadeResult> {
  // QA mode: prepend a local Ollama entry to every tier so the full system can
  // be exercised without cloud API keys.  Never used in production.
  const qaEntry: CascadeEntry | null =
    process.env["FOUNDEROS_QA_LOCAL_ONLY"] === "1"
      ? { provider: "lmstudio" as const, modelId: process.env["LM_STUDIO_MODEL"] ?? "founderos:latest" }
      : null;
  const entries = qaEntry ? [qaEntry, ...CASCADE[tier]] : CASCADE[tier];
  const maxTokens = opts.maxTokens ?? TIER_MAX_TOKENS[tier];
  const tenantId  = opts.tenant_id ?? "turicks";
  const errors: Error[] = [];

  for (const entry of entries) {
    const key = `${entry.provider}:${entry.modelId}`;

    // Skip providers with no API key — avoids wasted 401 HTTP calls
    if (!hasProviderKey(entry.provider)) {
      log.debug({ tier, model: key }, "Skipping provider — API key not configured");
      errors.push(new Error(`${key}: no API key configured`));
      continue;
    }

    try {
      const breaker = getBreaker(key);

      if (breaker.opened) {
        log.debug({ tier, model: key }, "Circuit breaker open — skipping provider");
        errors.push(new Error(`${key}: circuit breaker open`));
        continue;
      }

      const { text, tokensIn, tokensOut } = await getLimiter(entry.provider).schedule(() =>
        breaker.fire(entry, messages, entry.maxTokens ?? maxTokens),
      );

      // Record cost (non-blocking — DB failure must not break LLM call)
      const pricing = MODEL_COST_PER_1M[entry.modelId];
      const costUsd = pricing
        ? (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000
        : 0;

      logLlmCost({
        tenant_id: tenantId,
        agent: opts.agent,
        tier,
        model: entry.modelId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd.toFixed(6),
        lead_id: opts.lead_id,
      }).catch((err: unknown) => {
        const e    = err instanceof Error ? err : new Error(String(err));
        const code = (e as NodeJS.ErrnoException).code ?? "";
        log.warn({ err: e.message || code || "UNKNOWN" }, "Failed to log LLM cost");
      });

      log.debug(
        { tier, model: entry.modelId, tokensIn, tokensOut, costUsd: costUsd.toFixed(6) },
        "LLM call success",
      );

      return { text, model: entry.modelId, provider: entry.provider, tier, tokensIn, tokensOut, costUsd };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);
      log.warn(
        { tier, model: entry.modelId, provider: entry.provider, err: error.message },
        "Cascade entry failed — trying next",
      );
    }
  }

  throw new AggregateError(
    errors,
    `All cascade entries for tier "${tier}" failed:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`,
  );
}

// ── Planner (Phase 3 — two-phase LLM execution) ───────────────────────────────

/**
 * Structured plan returned by runPlanner.
 * Each step maps to one tool call in runToolExecutor.
 */
const PlanSchema = z.object({
  steps: z.array(
    z.object({
      tool: z.string().describe("Tool name to call"),
      args: z.record(z.unknown()).describe("Arguments to pass to the tool"),
      rationale: z.string().optional().describe("One-line reason for this step"),
    }),
  ),
  summary: z.string().describe("One-line summary of the overall plan"),
});

export type LLMPlan = z.infer<typeof PlanSchema>;

/**
 * JSON schema hint injected into the system prompt so the model knows what
 * shape to return. Plain text — no markdown, no code fences.
 */
const PLAN_JSON_INSTRUCTION =
  '\n\nCRITICAL: Respond with ONLY a JSON object. No markdown. No explanation. ' +
  'The object must match this exact shape:\n' +
  '{"steps":[{"tool":"<string>","args":{<key>:<value>},"rationale":"<string>"}],"summary":"<string>"}';

/**
 * Inject JSON instruction into the system message (appends to existing system
 * prompt if present; adds a new system message if there is none).
 */
function injectJsonInstruction(msgs: ChatMessage[]): ChatMessage[] {
  const sysIdx = msgs.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    const copy  = [...msgs] as ChatMessage[];
    const entry = copy[sysIdx]!;
    copy[sysIdx] = { role: entry.role, content: entry.content + PLAN_JSON_INSTRUCTION };
    return copy;
  }
  return [{ role: "system" as const, content: PLAN_JSON_INSTRUCTION.trim() }, ...msgs];
}

/**
 * Extract JSON from a model response that might wrap it in markdown.
 * Returns the first {...} block found, or the whole string if none.
 */
function extractJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

/**
 * TWO-PHASE Pattern — Phase A (PLAN):
 * Calls a cloud LLM with NO tools bound. Returns a structured execution plan.
 * CEO tier: never cached (decisions must be fresh).
 * MD / NANO tier: Redis-cacheable (Phase 2A adds caching layer).
 *
 * Uses direct fetch — no .withStructuredOutput() dependency.
 * Zod validates the response; retries once on parse error before moving to next entry.
 */
export async function runPlanner(
  tier: CascadeTier,
  messages: BaseMessage[],
  opts: Pick<CascadeCallOpts, "agent" | "tenant_id">,
): Promise<LLMPlan> {
  // Use only cloud providers for planning (skip lmstudio/local entries)
  const entries = CASCADE[tier].filter((e) => e.provider !== "lmstudio");
  if (entries.length === 0) {
    throw new Error(`runPlanner: no cloud entries in tier "${tier}"`);
  }

  const maxTokens = TIER_MAX_TOKENS[tier];
  const errors: Error[] = [];

  // Inject JSON schema instruction into system prompt so the model returns structured output
  const baseMsgs  = toMessages(messages);
  const planMsgs  = injectJsonInstruction(baseMsgs);

  for (const entry of entries) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Use planMsgs (with JSON instruction) directly via the provider fetch functions
        const result = await getLimiter(entry.provider).schedule(async () => {
          const temp = 0.3;
          switch (entry.provider) {
            case "anthropic": return callAnthropic(entry, planMsgs, maxTokens, temp);
            case "google":    return callGoogle(entry, planMsgs, maxTokens, temp);
            default:          return callOpenAICompat(
              entry, planMsgs, maxTokens, temp,
              entry.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
              entry.provider === "openrouter" ? (env.OPENROUTER_API_KEY ?? "") : (env.OPENAI_API_KEY ?? ""),
            );
          }
        });
        const raw  = extractJson(result.text);
        const plan = PlanSchema.parse(JSON.parse(raw));
        log.debug({ tier, model: entry.modelId, steps: plan.steps.length }, "Planner returned plan");
        return plan;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0) {
          log.debug({ tier, model: entry.modelId, err: error.message }, "Planner parse error — retrying once");
          continue; // retry with same entry
        }
        errors.push(error);
        log.warn({ tier, model: entry.modelId, err: error.message }, "Planner entry failed — trying next");
      }
    }
  }

  throw new AggregateError(errors, `runPlanner: all cloud entries for tier "${tier}" failed`);
}

// ── Safe JSON Parser ──────────────────────────────────────────────────────────

/**
 * Robust JSON extractor + parser shared by all agent nodes and the critic.
 *
 * Strategy:
 *  1. Strip markdown fences (```json ... ```)
 *  2. Extract FIRST balanced {...} block using bracket-counting.
 *     Greedy regex (/\{[\s\S]*\}/) captures from first { to LAST }, which
 *     incorrectly merges two consecutive JSON objects into invalid JSON.
 *     Bracket-counting stops at the closing brace that balances the first {.
 *  3. Try JSON.parse — fast path
 *  4. Try jsonrepair — fixes common issues: trailing commas, single quotes,
 *     unquoted keys, truncated strings
 *  5. Return null (never throws) — callers decide recovery strategy
 *
 * @param text - Raw model output string
 * @returns Parsed object cast to T, or null if no valid JSON found
 */
export function safeParseJson<T = Record<string, unknown>>(text: string): T | null {
  // Step 1: strip markdown fences
  let clean = text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();

  // Step 2: extract first BALANCED {...} block using bracket-counting.
  // This prevents the greedy-regex bug where two consecutive JSON objects
  // (common Ollama output) are merged into one invalid string.
  const start = clean.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < clean.length; i++) {
      const ch = clean[i]!;

      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end !== -1) {
      clean = clean.slice(start, end + 1);
    }
  }

  // Step 3: fast path
  try {
    return JSON.parse(clean) as T;
  } catch {
    // fall through to repair
  }

  // Step 4: jsonrepair fallback — ONLY when the text looks like JSON.
  // Avoids jsonrepair turning plain prose ("Here is your email: ...") into
  // unexpected key-value pairs that silently bypass catch blocks in callers.
  if (clean.includes("{") || clean.includes("[")) {
    try {
      const repaired = jsonrepair(clean);
      log.debug({ originalLength: clean.length }, "safeParseJson: used jsonrepair to fix malformed JSON");
      return JSON.parse(repaired) as T;
    } catch {
      // fall through
    }
  }

  log.debug({ raw: clean.slice(0, 200) }, "safeParseJson: no valid JSON found — returning null");
  return null;
}

// ── Tool Executor (Phase 3 — two-phase LLM execution) ────────────────────────

export interface ToolExecutorOpts {
  /** Agent name for logging. */
  agent: string;
  /** Tenant for cost tracking. */
  tenant_id?: string;
  /** Additional context to include in the LLM args-refinement prompt. */
  context?: string;
}

export interface ToolExecutorResult {
  /** The result returned by tool.execute(). */
  toolResult: import("../tools/index.js").ToolResult;
  /** The finalised args passed to the tool (may differ from argsHint after LLM refinement). */
  finalArgs: Record<string, unknown>;
  /** Model that produced the refined args, or "fallback" if all LLMs failed. */
  model: string;
}

/**
 * TWO-PHASE Pattern — Phase B (EXECUTE):
 * Calls a LOCAL LLM (Ollama/LM Studio via CASCADE["code"]) to validate and
 * optionally refine the args hint, then executes the tool.
 *
 * Fallback chain: lmstudio → openrouter/qwen3-coder:free → google/gemini-2.0-flash
 * If ALL fail, argsHint is used directly (fail-open — better to run the tool
 * with unrefined args than to block the entire pipeline).
 *
 * Why one tool per call:
 *   Qwen3 ≤ 14B is unreliable with parallel tool binding. Binding ONE tool per
 *   call gives deterministic structured output and simplifies error handling.
 *
 * @param toolName  Name registered in src/tools/index.ts
 * @param argsHint  Initial args from the planner or the calling node
 * @param opts      Logging + context options
 */
export async function runToolExecutor(
  toolName: string,
  argsHint: Record<string, unknown>,
  opts: ToolExecutorOpts,
): Promise<ToolExecutorResult> {
  // Lazy import to avoid circular dependency at module load
  const { getTool } = await import("../tools/index.js");

  const tool = getTool(toolName);
  if (!tool) {
    throw new Error(`runToolExecutor: tool "${toolName}" not found in registry`);
  }

  const tenantId = opts.tenant_id ?? "turicks";

  // Build the args-refinement prompt
  const contextBlock = opts.context ? `\nContext: ${opts.context}` : "";
  const systemPrompt =
    `You are a precise argument validator. Given a tool and initial args, ` +
    `return the best possible args as a JSON object. ` +
    `Respond with ONLY a JSON object — no markdown, no explanation.` +
    contextBlock;

  const userPrompt =
    `Tool: ${tool.name}\n` +
    `Description: ${tool.description}\n` +
    `Initial args: ${JSON.stringify(argsHint)}\n\n` +
    `Return the validated/refined args as a JSON object.`;

  const msgs: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Try CASCADE["code"] entries (local first, then cloud fallbacks)
  const codeEntries = CASCADE["code"];
  let finalArgs = argsHint;
  let usedModel  = "fallback";

  for (const entry of codeEntries) {
    try {
      const maxTokens = 512; // args should be compact
      const result = await getLimiter(entry.provider).schedule(async () => {
        const temp = 0.1; // deterministic args
        switch (entry.provider) {
          case "lmstudio":
            return callOpenAICompat(entry, msgs, maxTokens, temp, `${env.LM_STUDIO_URL}/v1`, "lm-studio", true);
          case "openrouter":
            return callOpenAICompat(entry, msgs, maxTokens, temp, "https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY ?? "");
          case "google":
            return callGoogle(entry, msgs, maxTokens, temp);
          default:
            return callOpenAICompat(entry, msgs, maxTokens, temp, "https://api.openai.com/v1", env.OPENAI_API_KEY ?? "");
        }
      });

      // Try to parse refined args from LLM response
      const raw = extractJson(result.text);
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Validate: must be a non-empty object (not an array, not null)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        finalArgs = parsed;
        usedModel  = entry.modelId;

        // Record cost (non-blocking)
        const pricing = MODEL_COST_PER_1M[entry.modelId];
        const costUsd = pricing
          ? (result.tokensIn * pricing.input + result.tokensOut * pricing.output) / 1_000_000
          : 0;
        logLlmCost({
          tenant_id: tenantId,
          agent: opts.agent,
          tier: "code",
          model: entry.modelId,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          cost_usd: costUsd.toFixed(6),
        }).catch((err: unknown) => {
          const e    = err instanceof Error ? err : new Error(String(err));
          const code = (e as NodeJS.ErrnoException).code ?? "";
          log.warn({ err: e.message || code || "UNKNOWN" }, "runToolExecutor: failed to log cost");
        });

        log.debug({ tool: toolName, model: entry.modelId, finalArgs }, "runToolExecutor: args refined by LLM");
        break; // success — stop trying entries
      }

      // Parsed but empty object — treat as parse failure, try next
      log.debug({ tool: toolName, model: entry.modelId }, "runToolExecutor: LLM returned empty args — trying next entry");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.debug({ tool: toolName, model: entry.modelId, err: error.message }, "runToolExecutor: LLM entry failed — trying next");
    }
  }

  // Execute the tool with finalArgs (refined or original hint)
  const toolResult = await tool.execute(finalArgs);

  log.debug(
    { tool: toolName, model: usedModel, success: toolResult.success },
    "runToolExecutor: tool executed",
  );

  return { toolResult, finalArgs, model: usedModel };
}

// ── Budget Guard ──────────────────────────────────────────────────────────────

/**
 * Check if today's spend exceeds BUDGET_DAILY_USD.
 * Call before expensive CEO / deep_research operations.
 * Fails OPEN when the cost-tracking DB is unreachable — better to allow LLM
 * calls than to block all agents because the DB is down.
 */
export async function checkBudget(tenantId: string): Promise<void> {
  let spent = 0;
  try {
    const { getTodayCostUsd } = await import("../db/queries.js");
    spent = await getTodayCostUsd(tenantId);
  } catch (dbErr) {
    const code = (dbErr as NodeJS.ErrnoException).code ?? "UNKNOWN";
    log.warn(
      { tenantId, code, err: (dbErr as Error).message || code },
      "checkBudget: DB unavailable — assuming $0 spend",
    );
    return;
  }

  if (spent >= env.BUDGET_DAILY_USD) {
    throw new Error(
      `Budget exceeded: $${spent.toFixed(4)} spent today, limit is $${env.BUDGET_DAILY_USD}. ` +
        `Free-tier models only until midnight UTC.`,
    );
  }

  log.debug({ tenantId, spent: spent.toFixed(4), limit: env.BUDGET_DAILY_USD }, "Budget OK");
}
