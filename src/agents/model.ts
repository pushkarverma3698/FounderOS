/**
 * FounderOS v2 — Model Factory
 * =============================
 * ONE primary model for the whole office (supervisor + all sub-agents).
 * Replaces the old 8-tier cascade with a single, env-swappable tool-calling model.
 *
 * Why one model: for a single-user tool, a multi-provider failover cascade is
 * over-engineering. Gemini Flash is cheap, fast, has 1M context, and supports
 * tool-calling — exactly what a ReAct/supervisor loop needs.
 *
 * ── The "Unknown author: supervisor" fix ──────────────────────────────────────
 * @langchain/langgraph-supervisor tags messages with the agent's `name`
 * (e.g. "supervisor", "research"). The Google GenAI adapter maps a message's
 * `name` straight to a Gemini "author" and throws on anything that isn't
 * ai/model/system/human/tool. Since `includeAgentName: "inline"` already embeds
 * the agent name in the message CONTENT, we can safely strip the `name`
 * attribute before it reaches Gemini — no information is lost, and Gemini stops
 * choking. We do this by subclassing the chat model and sanitising messages in
 * both the generate and stream paths.
 *
 * ── 503 fallback cascade ────────────────────────────────────────────────────
 * Gemini 2.5 Flash occasionally returns 503 "high demand" errors during traffic
 * spikes. Fallback chain: gemini-2.5-flash → gemini-2.5-flash-lite.
 * gemini-2.5-flash-lite confirmed available (4K RPM, unlimited RPD, June 2026).
 * Deprecated models (gemini-1.5-flash, gemini-2.0-flash, gemini-2.0-flash-001)
 * are NOT in the chain — all return 404 from Google API as of June 2026.
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model" });

/**
 * Models to try in order when the primary returns a 503.
 * Chain: gemini-2.5-flash → gemini-2.5-flash-lite (confirmed working, June 2026).
 * Deprecated models (gemini-1.5-flash, gemini-2.0-flash) are intentionally absent.
 */
const MODEL_FALLBACK_CHAIN: Record<string, string[]> = {
  "gemini-2.5-flash":      ["gemini-2.5-flash-lite"],
  "gemini-2.5-flash-lite": [],
  "gemini-2.5-pro":        [],
};

/**
 * Exponential backoff delays for the primary model retry loop.
 * 3 retries: 2s → 4s → 8s. Total max extra wait: 14s.
 * Exported so tests can assert on the constant and calculate expected call counts.
 */
export const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

/** Sleep helper used for retry backoff. Uses setTimeout so fake timers work in tests. */
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detect a transient (retryable) error from the Google Generative AI SDK.
 * Covers capacity, rate-limit, and network blips — everything where retrying the
 * same request or a fallback model is the right move. Deliberately does NOT match
 * 400/401/404 (those are caller/auth errors that retrying can never fix).
 *
 * Why broad: under a Gemini capacity spike the SDK throws a mix of 503 "high
 * demand", 429 "rate limit", 500, and raw socket errors (ECONNRESET / fetch
 * failed). Treating all of them as transient is what keeps the supervisor from
 * returning an empty route ("none") on a blip instead of retrying.
 *
 * Name kept as is503Error for backwards-compat (call sites + tests).
 */
export function is503Error(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("429") ||
    msg.includes("high demand") ||
    msg.includes("Service Unavailable") ||
    msg.includes("Internal Server Error") ||
    /rate.?limit/i.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("socket hang up") ||
    /fetch failed/i.test(msg) ||
    /network (error|timeout)/i.test(msg)
  );
}

/**
 * Detect the Gemini SDK crash when a candidate has no content (empty completion).
 * This happens after HITL resume when Gemini returns a candidate with finishReason=STOP
 * but no content parts — the SDK checks for missing candidates[] but not for a candidate
 * with undefined .content, crashing at `candidateContent?.parts.length` (line 222 of
 * @langchain/google-genai@0.1.12 utils/common.js).
 * Exported so unit tests can assert on it.
 */
/**
 * Detect Gemini's 400 "GenerateContentRequest.contents: contents is not specified".
 * This fires when the LangChain→Gemini message conversion produces an empty
 * contents array — historically the wedged-thread killer on the HITL resume path.
 * Exported so unit tests can assert on it.
 */
export function isEmptyContentsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("contents is not specified");
}

export function isNoCandidatesError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return (
    err.message.includes("Cannot read properties of undefined") &&
    err.message.includes("'length'") &&
    (err.stack?.includes("mapGenerateContentResultToChatResult") ?? false)
  );
}

/**
 * Build a synthetic ChatResult from the last ToolMessage in the conversation.
 * Used as a last-resort fallback when Gemini returns an empty candidate after a tool call.
 * The tool result string is surfaced verbatim so nothing is silently swallowed.
 */
function syntheticResponseFromLastTool(messages: BaseMessage[]): import("@langchain/core/outputs").ChatResult {
  const toolMsgs = messages.filter(
    (m): m is ToolMessage => m._getType() === "tool" && typeof m.content === "string",
  );
  const lastToolContent = toolMsgs.length > 0
    ? (toolMsgs[toolMsgs.length - 1] as ToolMessage).content as string
    : "Action completed.";
  // ChatResult.generations is ChatGeneration[] (single-nested).
  // _generateUncached iterates generations and accesses .message.id directly.
  return {
    generations: [
      {
        text: lastToolContent,
        message: new AIMessage({ content: lastToolContent }),
        generationInfo: { model: "synthetic-fallback", provider: "founderos" } as Record<string, unknown>,
      },
    ],
    llmOutput: { provider: "founderos-synthetic" },
  };
}

/**
 * One-line shape summary of a message list for crash diagnostics:
 * "human:42 ai+2calls:0 tool:5252 system:1800". Lets us reconstruct what
 * the thread looked like if Gemini ever rejects a request again.
 */
export function describeMessageShapes(messages: BaseMessage[]): string {
  return messages
    .map((m) => {
      const calls = (m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0;
      const len = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
      return `${m._getType()}${calls ? `+${calls}calls` : ""}:${len}`;
    })
    .join(" ");
}

/** Synthetic user turn injected when sanitization leaves Gemini nothing valid to send. */
const RECOVERY_HUMAN_MESSAGE = "Continue with the current task based on the conversation so far.";

/**
 * Filter out messages with empty content before calling Gemini.
 * Prevents the 400 "GenerateContentRequest.contents: contents is not specified" error
 * that fires after HITL resume when a large tool output makes the message list invalid.
 * AIMessages with tool_calls but empty content string are kept (valid Gemini state).
 *
 * Guarantees the result always converts to a non-empty Gemini `contents` array:
 *  - never returns an empty or all-invalid list (synthesizes a human turn instead);
 *  - never returns a system-only list (Gemini moves system messages to
 *    systemInstruction, leaving contents empty → 400).
 */
export function sanitizeForGemini(messages: BaseMessage[]): BaseMessage[] {
  const valid = messages.filter((m) => {
    const withCalls = m as { tool_calls?: unknown[] };
    if (withCalls.tool_calls?.length) return true;
    if (typeof m.content === "string") return m.content.trim().length > 0;
    if (Array.isArray(m.content)) {
      if (m.content.length === 0) return false;
      // Also reject arrays where every text part is empty — Gemini rejects Content with no non-empty parts.
      return (m.content as Array<unknown>).some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        if (typeof part === "object" && part !== null) {
          const p = part as { type?: string; text?: string };
          if (p.type === "text") return (p.text ?? "").trim().length > 0;
          return true; // non-text parts (images, tool results) are always valid
        }
        return false;
      });
    }
    return false;
  });

  if (valid.length === 0) {
    log.error(
      { dropped: messages.length, shapes: describeMessageShapes(messages) },
      "All messages invalid for Gemini — synthesizing recovery turn instead of crashing",
    );
    return [new HumanMessage(RECOVERY_HUMAN_MESSAGE)];
  }

  const hasNonSystem = valid.some((m) => m._getType() !== "system");
  if (!hasNonSystem) {
    log.error(
      { shapes: describeMessageShapes(messages) },
      "Only system messages survived sanitization — appending synthetic user turn to keep Gemini contents non-empty",
    );
    return [...valid, new HumanMessage(RECOVERY_HUMAN_MESSAGE)];
  }

  return valid;
}

/** Return copies of any name-tagged messages with the `name` attribute removed. */
function stripNames(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.name == null) return m;
    // Clone preserving the message class (prototype) and all fields, drop name.
    const clone = Object.assign(Object.create(Object.getPrototypeOf(m)), m) as BaseMessage;
    (clone as { name?: string }).name = undefined;
    return clone;
  });
}

interface FounderChatGoogleFields {
  model: string;
  temperature: number;
  maxRetries: number;
  apiKey?: string;
  fallbackModels?: string[];
  openRouterFallback?: ChatOpenAI;
}

/**
 * Gemini chat model that:
 * 1. Tolerates langgraph-supervisor's name-tagged messages (strips `name` before Gemini sees it)
 * 2. Sanitizes empty messages before calling Gemini (prevents 400 on HITL resume)
 * 3. Cascades to cheaper fallback models on 503 errors
 * 4. Escapes to OpenRouter/GPT-4o-mini when all Google infra is down
 */
class FounderChatGoogle extends ChatGoogleGenerativeAI {
  /** Exposed for tests. Fallback model names in priority order. */
  readonly _fallbackModels: string[];
  private readonly _fallbackInstances: BaseChatModel[];
  /** Exposed for tests. OpenRouter fallback or null if key not set. */
  readonly _openRouterFallback: ChatOpenAI | null;
  private _openRouterBound: Runnable<BaseMessage[], BaseMessage> | null = null;

  constructor(fields: FounderChatGoogleFields) {
    const { fallbackModels = [], apiKey, openRouterFallback, ...rest } = fields;
    super({ ...rest, ...(apiKey ? { apiKey } : {}) });
    this._fallbackModels = fallbackModels;
    this._openRouterFallback = openRouterFallback ?? null;
    // Pre-build fallback instances (no further cascading — fallbackModels=[])
    this._fallbackInstances = fallbackModels.map(
      (m) =>
        new ChatGoogleGenerativeAI({
          model: m,
          temperature: fields.temperature,
          maxRetries: 1,
          ...(apiKey ? { apiKey } : {}),
        }),
    );
  }

  /** Pre-bind tools on the OpenRouter fallback so it's ready with correct tool format. */
  override bindTools(tools: StructuredTool[], kwargs?: Record<string, unknown>) {
    if (this._openRouterFallback) {
      this._openRouterBound = this._openRouterFallback.bindTools(
        tools,
        kwargs,
      ) as unknown as Runnable<BaseMessage[], BaseMessage>;
    }
    return super.bindTools(tools, kwargs);
  }

  /**
   * When the primary model returns an empty completion on a non-tool turn (a
   * deterministic gemini-2.5-flash quirk for certain prompts), try each Google
   * fallback model in order and return the first that produces real output
   * (non-empty text or a tool call). Returns null if none recover — the caller
   * then fails loud rather than fabricating a success.
   */
  private async _tryFallbacksForEmptyCompletion(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult | null> {
    for (let i = 0; i < this._fallbackInstances.length; i++) {
      const fallback = this._fallbackInstances[i]!;
      try {
        log.info({ model: this._fallbackModels[i] }, "Trying fallback model for empty completion");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await (fallback as any)._generate(messages, options, runManager)) as ChatResult;
        const gen = result.generations[0];
        const text = typeof gen?.text === "string" ? gen.text.trim() : "";
        const toolCalls = (gen?.message as { tool_calls?: unknown[] } | undefined)?.tool_calls?.length ?? 0;
        if (text.length > 0 || toolCalls > 0) return result;
        log.warn({ model: this._fallbackModels[i] }, "Fallback model also returned empty — trying next");
      } catch (fallbackErr) {
        log.warn(
          { model: this._fallbackModels[i], err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
          "Fallback model threw on empty-completion recovery — trying next",
        );
      }
    }
    return null;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const sanitized = sanitizeForGemini(stripNames(messages));

    // Retry loop: attempt 0 = initial call; attempts 1..N = retries with backoff
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BACKOFF_MS[attempt - 1]!;
        log.warn({ attempt, delayMs: delay }, "Gemini transient error, retrying primary");
        await sleepMs(delay);
      }
      try {
        return await super._generate(sanitized, options, runManager);
      } catch (err) {
        if (is503Error(err)) {
          lastErr = err;
        } else if (isEmptyContentsError(err)) {
          // The sanitized list still converted to an empty Gemini contents array
          // (e.g. a converter quirk we haven't seen yet). Log the exact shape so
          // the next occurrence is diagnosable, then recover deterministically
          // with a minimal valid request instead of wedging the thread.
          log.error(
            { shapes: describeMessageShapes(sanitized) },
            "Gemini rejected request with empty contents — retrying once with minimal recovery context",
          );
          const lastTool = [...sanitized].reverse().find((m) => m._getType() === "tool" && typeof m.content === "string");
          const lastHuman = [...sanitized].reverse().find((m) => m._getType() === "human" && typeof m.content === "string");
          const recovery = [
            ...sanitized.filter((m) => m._getType() === "system").slice(0, 1),
            new HumanMessage(
              [
                lastHuman ? `Original request: ${(lastHuman.content as string).slice(0, 2000)}` : "",
                lastTool ? `Latest tool result:\n${(lastTool.content as string).slice(0, 4000)}` : "",
                "Continue the task and report the outcome.",
              ].filter(Boolean).join("\n\n"),
            ),
          ];
          return await super._generate(recovery, options, runManager);
        } else if (isNoCandidatesError(err)) {
          // SDK quirk: Gemini returns a candidate with finishReason=STOP but no content.
          const hasToolResult = sanitized.some(
            (m) => m._getType() === "tool" && typeof m.content === "string" && m.content.trim().length > 0,
          );
          if (hasToolResult) {
            // A tool DID run, Gemini just returned an empty completion. Surface the
            // last tool result verbatim so nothing is silently swallowed.
            log.warn({ module: "model" }, "Empty Gemini candidates after tool call — synthesizing from last tool result");
            return syntheticResponseFromLastTool(sanitized);
          }
          // Empty completion on a reasoning/routing turn with NO tool result to
          // surface. Fabricating "Action completed." here is a phantom-success lie
          // (claims the task is done when nothing happened — the #1 founder-reported
          // bug). This is DETERMINISTIC for a given prompt at temp 0 (verified
          // 2026-06-11: gemini-2.5-flash returns empty for certain supervisor routing
          // prompts that gemini-2.5-flash-lite handles fine), so retrying the SAME
          // model is futile. Hand off to the fallback model(s), which demonstrably
          // produce output for these prompts; only fail loud if they also come up empty.
          log.warn(
            { module: "model", fallbacks: this._fallbackModels },
            "Empty Gemini candidate on a non-tool turn — handing off to fallback model instead of faking success",
          );
          const recovered = await this._tryFallbacksForEmptyCompletion(sanitized, options, runManager);
          if (recovered) return recovered;
          throw new Error(
            "The model returned an empty response and no fallback model produced output. Please resend your message.",
          );
        } else {
          throw err; // non-transient, non-candidates → surface immediately
        }
      }
    }

    // All retries exhausted — try Google fallback models
    if (this._fallbackInstances.length > 0) {
      log.warn(
        { primary: this.model, fallbacks: this._fallbackModels },
        "Primary model retries exhausted, trying fallbacks",
      );
      for (let i = 0; i < this._fallbackInstances.length; i++) {
        const fallback = this._fallbackInstances[i]!;
        try {
          log.info({ model: this._fallbackModels[i] }, "Trying fallback model");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (fallback as any)._generate(sanitized, options, runManager);
        } catch (fallbackErr) {
          if (!is503Error(fallbackErr)) throw fallbackErr;
          lastErr = fallbackErr;
        }
      }
    }

    // Cross-provider escape hatch: OpenRouter/GPT-4o-mini
    const openRouterRunner = this._openRouterBound ?? this._openRouterFallback;
    if (openRouterRunner) {
      log.warn({ primary: this.model }, "All Google models failed, trying OpenRouter/GPT-4o-mini");
      try {
        const msg = await openRouterRunner.invoke(sanitized);
        return {
          generations: [
            {
              text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
              message: msg,
              generationInfo: { model: "openai/gpt-4o-mini", provider: "openrouter" },
            },
          ],
          llmOutput: { provider: "openrouter" },
        };
      } catch (orErr) {
        log.error({ err: orErr }, "OpenRouter fallback also failed");
        throw orErr;
      }
    }

    log.error({ fallbacks: this._fallbackModels }, "All fallback models returned 503");
    throw lastErr;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    const stripped = sanitizeForGemini(stripNames(messages));

    // Retry loop mirrors _generate: backoff on transient errors before falling through
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BACKOFF_MS[attempt - 1]!;
        log.warn({ attempt, delayMs: delay }, "Gemini transient error on stream, retrying primary");
        await sleepMs(delay);
      }
      try {
        yield* super._streamResponseChunks(stripped, options, runManager);
        return; // success — exit generator
      } catch (err) {
        if (!is503Error(err)) throw err;
        lastErr = err;
      }
    }

    // All retries exhausted — try fallback chain (intentionally empty in June 2026)
    if (this._fallbackInstances.length === 0) throw lastErr;

    log.warn({ primary: this.model }, "Primary model stream retries exhausted, trying fallbacks");

    for (let i = 0; i < this._fallbackInstances.length; i++) {
      const fallback = this._fallbackInstances[i]!;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        yield* (fallback as any)._streamResponseChunks(stripped, options, runManager);
        return;
      } catch (fallbackErr) {
        if (!is503Error(fallbackErr)) throw fallbackErr;
      }
    }
    throw lastErr;
  }
}

/**
 * Resolve the sampling temperature.
 *
 * Default 0 — DETERMINISM RULE: routing and tool-calling must be reproducible so
 * the eval harness scores the same behaviour every run and the founder gets
 * stable outcomes. A non-zero temperature makes the supervisor pick different
 * departments for the same input, which is exactly the instability we don't want.
 *
 * Override with AGENT_TEMPERATURE only for deliberately creative runs (and even
 * then, brand voice is enforced deterministically by the brand validator + HITL).
 */
function resolveTemperature(): number {
  const raw = process.env["AGENT_TEMPERATURE"];
  if (raw === undefined) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build an OpenRouter/GPT-4o-mini fallback if OPENROUTER_API_KEY is set.
 * Returns null if the key is absent — graceful degradation, not a crash.
 * Full chain: gemini-2.5-flash → gemini-2.5-flash-lite → openrouter/gpt-4o-mini.
 */
function buildOpenRouterFallback(temperature: number): ChatOpenAI | null {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) return null;
  return new ChatOpenAI({
    apiKey,
    configuration: { baseURL: "https://openrouter.ai/api/v1" },
    modelName: "openai/gpt-4o-mini",
    temperature,
    maxRetries: 1,
  });
}

/**
 * Build the office model. Tool-calling capable.
 * AGENT_MODEL env var swaps the model id without a code change.
 * On 503 errors, cascades: gemini-2.5-flash → gemini-2.5-flash-lite → openrouter/gpt-4o-mini.
 */
export function getModel(): FounderChatGoogle {
  const primaryModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
  const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  const fallbackModels = MODEL_FALLBACK_CHAIN[primaryModel] ?? [];
  const temperature = resolveTemperature();

  return new FounderChatGoogle({
    model: primaryModel,
    temperature,
    maxRetries: 2,
    fallbackModels,
    openRouterFallback: buildOpenRouterFallback(temperature) ?? undefined,
    ...(apiKey ? { apiKey } : {}),
  });
}
