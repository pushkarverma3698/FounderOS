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
 * spikes. The fallback chain is currently EMPTY because all known cheaper models
 * (gemini-1.5-flash, gemini-2.0-flash, gemini-2.0-flash-001) returned 404 as of
 * June 2026 (deprecated by Google). On a 503 we surface the error immediately.
 * Re-populate MODEL_FALLBACK_CHAIN once a confirmed working fallback is available.
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model" });

/**
 * Models to try in order when the primary returns a 503.
 * NOTE: gemini-1.5-flash, gemini-2.0-flash, gemini-2.0-flash-001 all return 404
 * from Google API as of June 2026 (deprecated). Fallback chain is intentionally
 * empty — on 503 we surface the error to the user rather than cascade to a
 * broken model. Re-populate once a stable cheaper fallback is confirmed working.
 */
const MODEL_FALLBACK_CHAIN: Record<string, string[]> = {
  "gemini-2.5-flash": [],
  "gemini-2.5-pro": [],
};

/**
 * Detect a 503 / "high demand" error from the Google Generative AI SDK.
 * Exported so unit tests can assert on it directly.
 */
export function is503Error(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes("503") || msg.includes("high demand") || msg.includes("Service Unavailable");
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
}

/**
 * Gemini chat model that:
 * 1. Tolerates langgraph-supervisor's name-tagged messages (strips `name` before Gemini sees it)
 * 2. Cascades to cheaper fallback models on 503 errors
 */
class FounderChatGoogle extends ChatGoogleGenerativeAI {
  /** Exposed for tests. Fallback model names in priority order. */
  readonly _fallbackModels: string[];
  private readonly _fallbackInstances: ChatGoogleGenerativeAI[];
  private readonly _fields: FounderChatGoogleFields;

  constructor(fields: FounderChatGoogleFields) {
    const { fallbackModels = [], apiKey, ...rest } = fields;
    super({ ...rest, ...(apiKey ? { apiKey } : {}) });
    this._fields = fields;
    this._fallbackModels = fallbackModels;
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

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const stripped = stripNames(messages);
    try {
      return await super._generate(stripped, options, runManager);
    } catch (primaryErr) {
      if (!is503Error(primaryErr) || this._fallbackInstances.length === 0) throw primaryErr;

      log.warn(
        { primary: this.model, fallbacks: this._fallbackModels },
        "Primary model 503, trying fallbacks",
      );

      let lastErr: unknown = primaryErr;
      for (let i = 0; i < this._fallbackInstances.length; i++) {
        const fallback = this._fallbackInstances[i]!;
        try {
          log.info({ model: this._fallbackModels[i] }, "Trying fallback model");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (fallback as any)._generate(stripped, options, runManager);
        } catch (fallbackErr) {
          if (!is503Error(fallbackErr)) throw fallbackErr;
          lastErr = fallbackErr;
        }
      }
      log.error({ fallbacks: this._fallbackModels }, "All fallback models returned 503");
      throw lastErr;
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    // For streaming we fall back to non-streaming generate on 503 (simpler, safe)
    try {
      yield* super._streamResponseChunks(stripNames(messages), options, runManager);
    } catch (primaryErr) {
      if (!is503Error(primaryErr) || this._fallbackInstances.length === 0) throw primaryErr;

      log.warn(
        { primary: this.model },
        "Primary model 503 on stream, falling back",
      );

      // Use the first available fallback via _generate (not streaming — acceptable
      // for a capacity-spike fallback path)
      for (let i = 0; i < this._fallbackInstances.length; i++) {
        const fallback = this._fallbackInstances[i]!;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          yield* (fallback as any)._streamResponseChunks(stripNames(messages), options, runManager);
          return;
        } catch (fallbackErr) {
          if (!is503Error(fallbackErr)) throw fallbackErr;
        }
      }
      throw primaryErr;
    }
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
 * Build the office model. Tool-calling capable.
 * AGENT_MODEL env var swaps the model id without a code change.
 * On 503 errors, automatically cascades to cheaper fallback models.
 */
export function getModel(): FounderChatGoogle {
  const primaryModel = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
  const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  const fallbackModels = MODEL_FALLBACK_CHAIN[primaryModel] ?? [];

  return new FounderChatGoogle({
    model: primaryModel,
    temperature: resolveTemperature(),
    maxRetries: 2,
    fallbackModels,
    ...(apiKey ? { apiKey } : {}),
  });
}
