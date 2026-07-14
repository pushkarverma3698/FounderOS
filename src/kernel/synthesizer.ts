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
import { clampToolOutput } from "./tool-output-guard.js";

/** Per-step char cap on the JSON the synthesizer re-reads (~2k tokens each). */
export const SYNTH_STEP_OUTPUT_MAX_CHARS = 8_000;

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

export function makeSynthesizeNode(model: KernelChatModel) {
  return async function synthesize(state: KernelStateType): Promise<KernelUpdate> {
    // Contract-validated outputs can still carry unbounded strings — bound each
    // step's JSON before the final LLM call (token protection, mirrors the
    // worker-loop clamp in tool-output-guard.ts).
    const okResults = state.results
      .filter((r): r is Extract<StepResult, { status: "ok" }> => r.status === "ok")
      .map((r) => ({
        step_id: r.step_id,
        output_json: clampToolOutput(JSON.stringify(r.output, null, 2), SYNTH_STEP_OUTPUT_MAX_CHARS),
      }));

    const response = await model.invoke([
      new SystemMessage(SYNTHESIZER_PROMPT),
      new HumanMessage(JSON.stringify({ goal: state.mission.goal, step_results: okResults }, null, 2)),
    ]);
    const text = messageContentText(response.content) || JSON.stringify(response.content);

    return {
      mission: { ...state.mission, status: "done" },
      reply: text.trim() + receiptsBlock(state.results),
    };
  };
}
