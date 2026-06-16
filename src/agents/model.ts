/**
 * FounderOS v2 — Model Factory
 * =============================
 * ONE primary model for the whole office (supervisor + all sub-agents).
 * Supports standard LangChain provider models (Google, Anthropic, OpenAI, etc.).
 *
 * ── The "Unknown author: supervisor" fix ──────────────────────────────────────
 * @langchain/langgraph-supervisor tags messages with the agent's `name`
 * (e.g. "supervisor", "research"). The Google GenAI adapter maps a message's
 * `name` straight to a Gemini "author" and throws on anything that isn't
 * ai/model/system/human/tool. Since `includeAgentName: "inline"` already embeds
 * the agent name in the message CONTENT, we strip the `name`
 * attribute before it reaches Gemini.
 *
 * ── 503 fallback cascade ────────────────────────────────────────────────────
 * Gemini 2.5 Flash occasionally returns 503 "high demand" errors during traffic
 * spikes. Fallback chain: gemini-2.5-flash → gemini-2.5-flash-lite.
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { AIMessageChunk } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model" });

const MODEL_FALLBACK_CHAIN: Record<string, string[]> = {
  "gemini-2.5-flash":      ["gemini-2.5-flash-lite"],
  "gemini-2.5-flash-lite": [],
  "gemini-2.5-pro":        [],
};

export const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * A NON-recoverable quota/credit/billing error (distinct from a transient 429
 * rate-limit or 503 capacity blip). "Your prepayment credits are depleted",
 * "exceeded your current quota", billing/payment failures — none of these clear
 * within a request, and on Gemini they share the API key with our fallback
 * models, so retrying the primary OR the same-key fallbacks only burns latency.
 * When this is true we skip straight to a different-key provider (OpenRouter).
 *
 * Deliberately narrow: plain "429 rate limit, please retry" and "503 high demand"
 * are excluded — those DO recover and must keep their retry/backoff path.
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    /credits?\s*(are\s*)?depleted/.test(msg) ||
    /exceeded your current quota/.test(msg) ||
    /quota.*exceeded/.test(msg) ||
    /insufficient\s*(credits|funds|quota|balance)/.test(msg) ||
    /payment\s*required/.test(msg) ||
    (/\bbilling\b/.test(msg) && /quota|credit|exceed|depleted|payment/.test(msg))
  );
}

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

function syntheticResponseFromLastTool(messages: BaseMessage[]): ChatResult {
  const toolMsgs = messages.filter(
    (m): m is ToolMessage => m._getType() === "tool" && typeof m.content === "string",
  );
  const lastToolContent = toolMsgs.length > 0
    ? (toolMsgs[toolMsgs.length - 1] as ToolMessage).content as string
    : "Action completed.";
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

export function describeMessageShapes(messages: BaseMessage[]): string {
  return messages
    .map((m) => {
      const calls = (m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0;
      const len = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
      return `${m._getType()}${calls ? `+${calls}calls` : ""}:${len}`;
    })
    .join(" ");
}

const RECOVERY_HUMAN_MESSAGE = "Continue with the current task based on the conversation so far.";

export function sanitizeForGemini(messages: BaseMessage[]): BaseMessage[] {
  const valid = messages.filter((m) => {
    const withCalls = m as { tool_calls?: unknown[] };
    if (withCalls.tool_calls?.length) return true;
    if (typeof m.content === "string") return m.content.trim().length > 0;
    if (Array.isArray(m.content)) {
      if (m.content.length === 0) return false;
      return (m.content as Array<unknown>).some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        if (typeof part === "object" && part !== null) {
          const p = part as { type?: string; text?: string };
          if (p.type === "text") return (p.text ?? "").trim().length > 0;
          return true;
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

function stripNames(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.name == null) return m;
    const clone = Object.assign(Object.create(Object.getPrototypeOf(m)), m) as BaseMessage;
    (clone as { name?: string }).name = undefined;
    return clone;
  });
}

// ── Provider Adapters ─────────────────────────────────────────────────────────

export interface ProviderAdapter {
  sanitizeMessages(messages: BaseMessage[]): BaseMessage[];
  isTransientError(err: unknown): boolean;
  handleError(
    err: unknown,
    messages: BaseMessage[],
    options: any,
    runManager: any,
    generateFn: (msgs: BaseMessage[]) => Promise<ChatResult>,
  ): Promise<ChatResult>;
}

export class GeminiAdapter implements ProviderAdapter {
  sanitizeMessages(messages: BaseMessage[]): BaseMessage[] {
    return sanitizeForGemini(stripNames(messages));
  }

  isTransientError(err: unknown): boolean {
    return is503Error(err);
  }

  async handleError(
    err: unknown,
    messages: BaseMessage[],
    options: any,
    runManager: any,
    generateFn: (msgs: BaseMessage[]) => Promise<ChatResult>,
  ): Promise<ChatResult> {
    if (isEmptyContentsError(err)) {
      log.error(
        { shapes: describeMessageShapes(messages) },
        "Gemini rejected request with empty contents — retrying once with minimal recovery context",
      );
      const lastTool = [...messages].reverse().find((m) => m._getType() === "tool" && typeof m.content === "string");
      const lastHuman = [...messages].reverse().find((m) => m._getType() === "human" && typeof m.content === "string");
      const recovery = [
        ...messages.filter((m) => m._getType() === "system").slice(0, 1),
        new HumanMessage(
          [
            lastHuman ? `Original request: ${(lastHuman.content as string).slice(0, 2000)}` : "",
            lastTool ? `Latest tool result:\n${(lastTool.content as string).slice(0, 4000)}` : "",
            "Continue the task and report the outcome.",
          ].filter(Boolean).join("\n\n"),
        ),
      ];
      return generateFn(recovery);
    }

    if (isNoCandidatesError(err)) {
      const hasToolResult = messages.some(
        (m) => m._getType() === "tool" && typeof m.content === "string" && m.content.trim().length > 0,
      );
      if (hasToolResult) {
        log.warn({ module: "model" }, "Empty Gemini candidates after tool call — synthesizing from last tool result");
        return syntheticResponseFromLastTool(messages);
      }
      throw err; // Let caller trigger fallback models
    }

    throw err;
  }
}

export class StandardAdapter implements ProviderAdapter {
  sanitizeMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages;
  }

  isTransientError(err: unknown): boolean {
    return is503Error(err);
  }

  async handleError(
    err: unknown,
    messages: BaseMessage[],
    options: any,
    runManager: any,
    generateFn: (msgs: BaseMessage[]) => Promise<ChatResult>,
  ): Promise<ChatResult> {
    throw err;
  }
}

// ── Polymorphic Model Wrapper ─────────────────────────────────────────────────

export interface FounderChatModelFields {
  primaryModel: BaseChatModel;
  adapter: ProviderAdapter;
  fallbackModels?: string[];
  fallbackInstances?: BaseChatModel[];
  openRouterFallback?: ChatOpenAI;
}

export class FounderChatModel extends BaseChatModel {
  primaryModel: BaseChatModel;
  readonly adapter: ProviderAdapter;
  readonly _fallbackModels: string[];
  readonly _fallbackInstances: BaseChatModel[];
  readonly _openRouterFallback: ChatOpenAI | null;
  private _openRouterBound: Runnable<BaseMessage[], BaseMessage> | null = null;

  constructor(fields: FounderChatModelFields) {
    super({});
    this.primaryModel = fields.primaryModel;
    this.adapter = fields.adapter;
    this._fallbackModels = fields.fallbackModels ?? [];
    this._fallbackInstances = fields.fallbackInstances ?? [];
    this._openRouterFallback = fields.openRouterFallback ?? null;
  }

  /**
   * Generate via either an unbound chat model (`_generate`) or a bound runnable
   * (a RunnableBinding from `.bindTools()`, which exposes `invoke` but no
   * `_generate`). Returns a ChatResult either way.
   */
  private async _generateWith(
    model: unknown,
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const m = model as any;
    if (typeof m._generate === "function") {
      return (await m._generate(messages, options, runManager)) as ChatResult;
    }
    const msg = (await m.invoke(messages, options)) as AIMessage;
    return {
      generations: [
        {
          text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          message: msg,
        },
      ],
      llmOutput: {},
    };
  }

  /** Streaming counterpart of `_generateWith` — unbound model or bound runnable. */
  private async *_streamWith(
    model: unknown,
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    const m = model as any;
    if (typeof m._streamResponseChunks === "function") {
      yield* m._streamResponseChunks(messages, options, runManager);
      return;
    }
    const stream = await m.stream(messages, options);
    for await (const chunk of stream) {
      yield {
        text: typeof chunk.content === "string" ? chunk.content : "",
        message: chunk,
      } as any;
    }
  }

  get model(): string {
    // Defensive: BaseChatModel's super() ctor can invoke these getters before
    // `primaryModel` is assigned (newer @langchain/core calls _llmType in super).
    return (this.primaryModel as any)?.model ?? (this.primaryModel as any)?.modelName ?? "";
  }

  get temperature(): number {
    return (this.primaryModel as any)?.temperature ?? 0;
  }

  _llmType(): string {
    return (this.primaryModel as any)?._llmType?.() ?? "founder-chat-model";
  }

  override bindTools(tools: StructuredTool[], kwargs?: Record<string, unknown>) {
    // Return a STANDARD RunnableBinding (via `.bind`) whose `.kwargs.tools` holds
    // the provider-converted tool list. @langchain/langgraph-supervisor and
    // createReactAgent both depend on that contract: the supervisor reads
    // `.kwargs.tools` (and wraps the result in `withAgentName`), and
    // `_shouldBindTools` inspects it to avoid double-binding. A custom wrapper
    // without `.kwargs.tools` makes the supervisor hand a tool-less, bindTools-less
    // runnable to createReactAgent → "llm must define bindTools method".
    //
    // We never mutate `this`, so the single shared model instance is safe across
    // all departments + the supervisor. Tools flow into our retry/fallback
    // `_generate` via call options, so the underlying provider still receives them.
    // bindTools is optional on BaseChatModel in newer @langchain/core; concrete
    // chat models implement it, so assert non-null.
    // Keep the OpenRouter emergency fallback tool-aware (last-resort path in _generate).
    if (this._openRouterFallback) {
      this._openRouterBound = this._openRouterFallback.bindTools(
        tools,
        kwargs,
      ) as unknown as Runnable<BaseMessage[], BaseMessage>;
    }
    const boundPrimary = this.primaryModel.bindTools!(tools, kwargs) as unknown as {
      kwargs?: { tools?: unknown };
    };
    const convertedTools = boundPrimary.kwargs?.tools ?? tools;
    // `tools` isn't in the typed call-options shape, but provider _generate reads it.
    return this.bind({ tools: convertedTools, ...(kwargs ?? {}) } as Record<string, unknown>) as unknown as this;
  }

  private async _tryFallbacksForEmptyCompletion(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult | null> {
    for (let i = 0; i < this._fallbackInstances.length; i++) {
      const fallback = this._fallbackInstances[i]!;
      try {
        log.info({ model: this._fallbackModels[i] }, "Trying fallback model for empty completion");
        const result = await this._generateWith(fallback, messages, options, runManager);
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
    const sanitized = this.adapter.sanitizeMessages(messages);

    let lastErr: unknown;
    // When the primary fails with a depleted-credits/quota error, the same-key
    // Google fallbacks share that quota — skip them and jump to OpenRouter.
    let skipSameKeyFallbacks = false;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BACKOFF_MS[attempt - 1]!;
        log.warn({ attempt, delayMs: delay }, "Transient error, retrying primary");
        await sleepMs(delay);
      }
      try {
        return await this._generateWith(this.primaryModel, sanitized, options, runManager);
      } catch (err) {
        if (isQuotaExhaustedError(err)) {
          log.error(
            { primary: this.model },
            "Primary model credits/quota exhausted — skipping same-key fallbacks, failing fast to OpenRouter. ACTION: top up the provider billing account.",
          );
          lastErr = err;
          skipSameKeyFallbacks = true;
          break;
        }
        if (this.adapter.isTransientError(err)) {
          lastErr = err;
        } else {
          try {
            return await this.adapter.handleError(
              err,
              sanitized,
              options,
              runManager,
              async (recoveryMessages) => {
                return await this._generateWith(this.primaryModel, recoveryMessages, options, runManager);
              },
            );
          } catch (handlerErr) {
            if (isNoCandidatesError(handlerErr)) {
              log.warn(
                { fallbacks: this._fallbackModels },
                "Empty candidate on a non-tool turn — handing off to fallback model instead of faking success",
              );
              const recovered = await this._tryFallbacksForEmptyCompletion(sanitized, options, runManager);
              if (recovered) return recovered;
              throw new Error(
                "The model returned an empty response and no fallback model produced output. Please resend your message.",
              );
            }
            throw handlerErr;
          }
        }
      }
    }

    if (!skipSameKeyFallbacks && this._fallbackInstances.length > 0) {
      log.warn(
        { primary: this.model, fallbacks: this._fallbackModels },
        "Primary model retries exhausted, trying fallbacks",
      );
      for (let i = 0; i < this._fallbackInstances.length; i++) {
        const fallback = this._fallbackInstances[i]!;
        try {
          log.info({ model: this._fallbackModels[i] }, "Trying fallback model");
          return await this._generateWith(fallback, sanitized, options, runManager);
        } catch (fallbackErr) {
          if (isQuotaExhaustedError(fallbackErr)) {
            lastErr = fallbackErr;
            break; // same key → remaining Google fallbacks share the depleted quota
          }
          if (!this.adapter.isTransientError(fallbackErr)) throw fallbackErr;
          lastErr = fallbackErr;
        }
      }
    }

    const openRouterRunner = this._openRouterBound ?? this._openRouterFallback;
    if (openRouterRunner) {
      log.warn({ primary: this.model }, "All primary/fallback models failed, trying OpenRouter/GPT-4o-mini");
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

    log.error({ fallbacks: this._fallbackModels }, "All fallback models returned transient errors");
    throw lastErr;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    const stripped = this.adapter.sanitizeMessages(messages);

    let lastErr: unknown;
    let skipSameKeyFallbacks = false;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BACKOFF_MS[attempt - 1]!;
        log.warn({ attempt, delayMs: delay }, "Transient error on stream, retrying primary");
        await sleepMs(delay);
      }
      try {
        yield* this._streamWith(this.primaryModel, stripped, options, runManager);
        return;
      } catch (err) {
        if (isQuotaExhaustedError(err)) {
          log.error(
            { primary: this.model },
            "Primary model credits/quota exhausted on stream — failing fast. ACTION: top up the provider billing account.",
          );
          lastErr = err;
          skipSameKeyFallbacks = true;
          break; // same-key fallbacks share the depleted quota
        }
        if (!this.adapter.isTransientError(err)) throw err;
        lastErr = err;
      }
    }

    if (!skipSameKeyFallbacks && this._fallbackInstances.length > 0) {
      log.warn({ primary: this.model }, "Primary model stream retries exhausted, trying fallbacks");
      for (let i = 0; i < this._fallbackInstances.length; i++) {
        const fallback = this._fallbackInstances[i]!;
        try {
          yield* this._streamWith(fallback, stripped, options, runManager);
          return;
        } catch (fallbackErr) {
          if (isQuotaExhaustedError(fallbackErr)) {
            lastErr = fallbackErr;
            break; // same key → remaining Google fallbacks share the depleted quota
          }
          if (!this.adapter.isTransientError(fallbackErr)) throw fallbackErr;
          lastErr = fallbackErr;
        }
      }
    }

    const openRouterRunner = this._openRouterBound ?? this._openRouterFallback;
    if (openRouterRunner) {
      log.warn({ primary: this.model }, "All primary/fallback stream models failed, trying OpenRouter/GPT-4o-mini");
      try {
        const msg = await openRouterRunner.invoke(stripped);
        const chunk = new ChatGenerationChunk({
          text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          message: new AIMessageChunk({ content: msg.content }),
          generationInfo: { model: "openai/gpt-4o-mini", provider: "openrouter" },
        });
        yield chunk;
        await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, { chunk });
        return;
      } catch (orErr) {
        log.error({ err: orErr }, "OpenRouter stream fallback also failed");
        throw orErr;
      }
    }

    log.error({ fallbacks: this._fallbackModels }, "All stream fallback models returned transient errors");
    throw lastErr;
  }
}

function resolveTemperature(): number {
  const raw = process.env["AGENT_TEMPERATURE"];
  if (raw === undefined) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

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

function resolveProvider(modelName: string): "google" | "anthropic" | "openai" {
  const name = modelName.toLowerCase();
  if (name.includes("gemini")) return "google";
  if (name.includes("claude")) return "anthropic";
  return "openai";
}

export function getModel(): FounderChatModel {
  const primaryModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
  const temperature = resolveTemperature();
  const provider = resolveProvider(primaryModel);

  if (provider === "google") {
    const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    const fallbackModels = MODEL_FALLBACK_CHAIN[primaryModel] ?? [];
    // maxRetries: 0 — the Google SDK's own retry does long internal backoff
    // (~85s on a persistent 429), which stacks on top of OUR retry/fallback loop
    // and wedges every request when credits are depleted. We own retry timing
    // (RETRY_BACKOFF_MS) and fallback, so the SDK must fail fast.
    const fallbackInstances = fallbackModels.map(
      (m) =>
        new ChatGoogleGenerativeAI({
          model: m,
          temperature,
          maxRetries: 0,
          ...(apiKey ? { apiKey } : {}),
        }),
    );
    const primaryInstance = new ChatGoogleGenerativeAI({
      model: primaryModel,
      temperature,
      maxRetries: 0,
      ...(apiKey ? { apiKey } : {}),
    });

    return new FounderChatModel({
      primaryModel: primaryInstance,
      adapter: new GeminiAdapter(),
      fallbackModels,
      fallbackInstances,
      openRouterFallback: buildOpenRouterFallback(temperature) ?? undefined,
    });
  } else if (provider === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    const primaryInstance = new ChatAnthropic({
      model: primaryModel,
      temperature,
      maxRetries: 2,
      ...(apiKey ? { apiKey } : {}),
    });
    return new FounderChatModel({
      primaryModel: primaryInstance,
      adapter: new StandardAdapter(),
    });
  } else {
    const apiKey = process.env["OPENAI_API_KEY"];
    const primaryInstance = new ChatOpenAI({
      modelName: primaryModel,
      temperature,
      maxRetries: 2,
      ...(apiKey ? { apiKey } : {}),
    });
    return new FounderChatModel({
      primaryModel: primaryInstance,
      adapter: new StandardAdapter(),
    });
  }
}
