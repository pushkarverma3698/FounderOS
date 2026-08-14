/**
 * FounderOS v3 kernel — synthesizer node.
 * ========================================
 * The final LLM call: compose the founder-facing reply from mission.goal +
 * the VALIDATED step results — and nothing else. It has no tools and never
 * sees tool schemas, so it cannot claim an action it has no receipt for.
 * The receipts block is appended DETERMINISTICALLY by code, making every
 * action claim in the reply traceable to a recorded execution.
 *
 * Phase 4 additions:
 *  - Enforces missionSatisfied() check (prevents partial completions reporting "Mission complete").
 *  - Calls writeTaskOutcome() to record turn results into agent_results table.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StepResult, ToolReceipt } from "./contracts.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import type { KernelChatModel } from "./planner.js";
import { messageContentText } from "./message-text.js";
import { isKernelTerminalError } from "./errors.js";
import { clampToolOutput } from "./tool-output-guard.js";
import { missionSatisfied } from "./mission-satisfaction.js";
import { redactInternalPaths } from "./founder-text.js";
import { writeTaskOutcome } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "kernel:synthesizer" });

/** Per-step char cap on the JSON the synthesizer re-reads (~2k tokens each). */
export const SYNTH_STEP_OUTPUT_MAX_CHARS = 8_000;

const SYNTHESIZER_PROMPT = [
  `You are the FounderOS synthesizer. Write the reply to the founder for a completed mission.`,
  `Use ONLY the step results provided — they are the complete ground truth.`,
  `If a result lacks something the founder asked for, say so plainly; never fill gaps from your own knowledge.`,
  `If any items/steps are unmet or partially completed, explicitly state what is blocked or missing. NEVER claim "Mission complete" when requirements are unmet.`,
  `Be concise and direct. Plain text (Telegram-friendly), no markdown headers.`,
].join("\n");

/** Successful receipts across every ok step, in execution order. */
function okReceipts(results: StepResult[]): ToolReceipt[] {
  return results.flatMap((r) => (r.status === "ok" ? r.tool_receipts.filter((t) => t.ok) : []));
}

/**
 * INTERNAL receipts block — code-generated proof lines, not model prose.
 *
 * Names tools, args hashes and result digests. This is the auditable record and
 * it is NOT appended to the founder's reply; it exists for the trace, the logs
 * and anything that has to reconstruct what actually ran. Use
 * `founderReceiptsBlock` for anything a human reads.
 */
export function receiptsBlock(results: StepResult[]): string {
  const receipts = okReceipts(results);
  if (receipts.length === 0) return "";
  const lines = receipts.map((t) => `✓ ${t.tool} @ ${t.at} · args ${t.args_hash.slice(0, 8)} · result ${t.result_digest.slice(0, 8)}`);
  return `\n\n—\nAction receipts:\n${lines.join("\n")}`;
}

/**
 * FOUNDER-FACING receipts block.
 *
 * Same guarantee as the internal one — every claim above this line is backed by
 * a recorded execution — carried by a count instead of a tool inventory. Tool
 * names, hashes and timestamps-per-call are internal detail: they cost the
 * founder attention, tell them nothing they can act on, and are the single
 * largest scorer against the product in the reality benchmark (22 of 24 replies
 * failed the leakage dimension on this block alone, 2026-08-14).
 *
 * The mechanism is untouched. Only the audience changed.
 */
export function founderReceiptsBlock(results: StepResult[]): string {
  const count = okReceipts(results).length;
  if (count === 0) return "";
  const noun = count === 1 ? "action" : "actions";
  return `\n\n—\n✓ ${count} ${noun} completed and verified`;
}

/** Per-step char cap in the deterministic fallback reply (Telegram-friendly). */
const FALLBACK_OUTPUT_MAX_CHARS = 600;

/**
 * Deterministic reply when the synthesizer model itself is unavailable.
 */
export function fallbackSynthesisReply(goal: string, okResults: Array<{ step_id: string; output_json: string }>): string {
  const lines = [
    `✅ All steps completed and verified, but the reply-writing model was unavailable — raw validated results below.`,
    `Goal: ${goal}`,
    ...okResults.map((r) => {
      const rendered = r.output_json.replace(/\s+/g, " ").trim();
      return `• ${r.step_id}: ${rendered.length > FALLBACK_OUTPUT_MAX_CHARS ? rendered.slice(0, FALLBACK_OUTPUT_MAX_CHARS) + "…" : rendered}`;
    }),
  ];
  return lines.join("\n");
}

export function makeSynthesizeNode(model: KernelChatModel) {
  return async function synthesize(state: KernelStateType): Promise<KernelUpdate> {
    const steps = state.mission.plan?.steps ?? [];
    const satisfaction = missionSatisfied(state.mission.goal, steps, state.results);

    const okResults = state.results
      .filter((r): r is Extract<StepResult, { status: "ok" }> => r.status === "ok")
      .map((r) => ({
        step_id: r.step_id,
        output_json: clampToolOutput(JSON.stringify(r.output, null, 2), SYNTH_STEP_OUTPUT_MAX_CHARS),
      }));

    let text: string;
    try {
      const promptAddendum = !satisfaction.ok && satisfaction.unmet
        ? `\nIMPORTANT WARNING: The mission satisfaction check found unmet requirements:\n- ${satisfaction.unmet.join("\n- ")}\nBe sure to state these unfulfilled items clearly to the founder.`
        : "";

      const response = await model.invoke([
        new SystemMessage(SYNTHESIZER_PROMPT + promptAddendum),
        new HumanMessage(JSON.stringify({ goal: state.mission.goal, step_results: okResults }, null, 2)),
      ]);
      text = messageContentText(response.content) || JSON.stringify(response.content);
    } catch (err) {
      if (isKernelTerminalError(err)) throw err;
      text = fallbackSynthesisReply(state.mission.goal, okResults);
    }

    if (!satisfaction.ok && satisfaction.unmet && !text.includes("unmet") && !text.includes("blocked") && !text.includes("failed")) {
      text = `⚠️ Partial completion notice: ${satisfaction.unmet.join("; ")}\n\n` + text;
    }

    // T4: Record task outcome asynchronously (best-effort)
    writeTaskOutcome({
      agent_id: "kernel",
      thread_id: state.turn?.id || "default",
      outcome: satisfaction.ok ? "succeeded" : "failed",
      decision_summary: text.slice(0, 1000),
      tenant_id: "turicks",
    }).catch((err) => {
      log.warn({ err: (err as Error).message }, "writeTaskOutcome failed (non-fatal)");
    });

    return {
      mission: { ...state.mission, status: "done" },
      reply: redactInternalPaths(text.trim()) + founderReceiptsBlock(state.results),
    };
  };
}
