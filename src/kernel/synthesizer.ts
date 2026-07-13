/**
 * FounderOS v3 kernel — synthesizer node.
 * ========================================
 * The final LLM call: compose the founder-facing reply from mission.goal +
 * the VALIDATED step results — and nothing else. It has no tools and never
 * sees tool schemas, so it cannot claim an action it has no receipt for.
 * The receipts block is appended DETERMINISTICALLY by code, making every
 * action claim in the reply traceable to a recorded execution.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StepResult, ToolReceipt } from "./contracts.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import type { KernelChatModel } from "./planner.js";
import { messageContentText } from "./message-text.js";
import { isKernelTerminalError } from "./errors.js";

const SYNTHESIZER_PROMPT = [
  `You are the FounderOS synthesizer. Write the reply to the founder for a completed mission.`,
  `Use ONLY the step results provided — they are the complete ground truth.`,
  `If a result lacks something the founder asked for, say so plainly; never fill gaps from your own knowledge.`,
  `Be concise and direct. Plain text (Telegram-friendly), no markdown headers.`,
].join("\n");

/** Deterministic receipts block — code-generated proof lines, not model prose. */
export function receiptsBlock(results: StepResult[]): string {
  const receipts: ToolReceipt[] = results.flatMap((r) =>
    r.status === "ok" ? r.tool_receipts.filter((t) => t.ok) : [],
  );
  if (receipts.length === 0) return "";
  const lines = receipts.map((t) => `✓ ${t.tool} @ ${t.at} · args ${t.args_hash.slice(0, 8)} · result ${t.result_digest.slice(0, 8)}`);
  return `\n\n—\nAction receipts:\n${lines.join("\n")}`;
}

/** Per-step char cap in the deterministic fallback reply (Telegram-friendly). */
const FALLBACK_OUTPUT_MAX_CHARS = 600;

/**
 * Deterministic reply when the synthesizer model itself is unavailable. Every
 * step already completed and validated — losing the whole turn over a reply-
 * writing blip (the pre-2026-07-13 behaviour) throws away proven work. Honest
 * framing, raw validated outputs, no model prose.
 */
export function fallbackSynthesisReply(goal: string, okResults: Array<{ step_id: string; output: unknown }>): string {
  const lines = [
    `✅ All steps completed and verified, but the reply-writing model was unavailable — raw validated results below.`,
    `Goal: ${goal}`,
    ...okResults.map((r) => {
      const rendered = JSON.stringify(r.output);
      return `• ${r.step_id}: ${rendered.length > FALLBACK_OUTPUT_MAX_CHARS ? rendered.slice(0, FALLBACK_OUTPUT_MAX_CHARS) + "…" : rendered}`;
    }),
  ];
  return lines.join("\n");
}

export function makeSynthesizeNode(model: KernelChatModel) {
  return async function synthesize(state: KernelStateType): Promise<KernelUpdate> {
    const okResults = state.results
      .filter((r): r is Extract<StepResult, { status: "ok" }> => r.status === "ok")
      .map((r) => ({ step_id: r.step_id, output: r.output }));

    let text: string;
    try {
      const response = await model.invoke([
        new SystemMessage(SYNTHESIZER_PROMPT),
        new HumanMessage(JSON.stringify({ goal: state.mission.goal, step_results: okResults }, null, 2)),
      ]);
      text = messageContentText(response.content) || JSON.stringify(response.content);
    } catch (err) {
      // Budget caps, HITL interrupts, and timeout aborts propagate; anything
      // else degrades to the deterministic reply — the mission's validated
      // work survives a reply-writer blip.
      if (isKernelTerminalError(err)) throw err;
      text = fallbackSynthesisReply(state.mission.goal, okResults);
    }

    return {
      mission: { ...state.mission, status: "done" },
      reply: text.trim() + receiptsBlock(state.results),
    };
  };
}
