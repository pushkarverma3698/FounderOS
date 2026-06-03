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
 * Claude-later: set AGENT_MODEL=claude-... and (later) wire ChatAnthropic.
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
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";

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

/** Gemini chat model that tolerates langgraph-supervisor's name-tagged messages. */
class FounderChatGoogle extends ChatGoogleGenerativeAI {
  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(stripNames(messages), options, runManager);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    yield* super._streamResponseChunks(stripNames(messages), options, runManager);
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
 */
export function getModel(): ChatGoogleGenerativeAI {
  const model = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
  const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];

  return new FounderChatGoogle({
    model,
    temperature: resolveTemperature(),
    maxRetries: 2,
    ...(apiKey ? { apiKey } : {}),
  });
}
