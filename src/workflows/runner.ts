/**
 * FounderOS — Workflow Runner
 * ============================
 * Executes a workflow's steps sequentially through the existing office.
 *
 * Key design decisions:
 * - Steps run on the SAME Telegram thread as the conversation. The LangGraph
 *   checkpointer accumulates step outputs in thread history, so step N+1
 *   naturally sees step N's output — no explicit context chaining needed.
 * - Each step is just a runOfficeText call with a rendered task string.
 * - HITL gates fire normally — the founder approves inline just like any
 *   other office action.
 * - If a step is aborted (founder rejects HITL), the workflow stops early
 *   with a clear message. Remaining steps are skipped.
 *
 * This module is pure coordination — it has no LLM calls itself.
 */

import type { WorkflowDef } from "./types.js";
import { renderTemplate } from "./registry.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "workflow-runner" });

/** Callbacks injected by the Telegram command handler — no grammy imports here. */
export interface WorkflowCallbacks {
  /** Send a plain status message to the chat (e.g. "▶ Step 2/4: research"). */
  sendStatus(msg: string): Promise<void>;
  /**
   * Run a rendered task string through the office and send the reply to the chat.
   * Returns false if the step was aborted (HITL rejected or error).
   */
  runStep(task: string): Promise<boolean>;
}

export interface WorkflowResult {
  completed: boolean;
  stepsRun: number;
  abortedAt?: string; // step id that caused the abort
}

/**
 * Execute all steps of a workflow definition.
 * Sends progress messages + runs each step through the office.
 */
export async function runWorkflow(
  def: WorkflowDef,
  params: Record<string, string>,
  callbacks: WorkflowCallbacks,
): Promise<WorkflowResult> {
  const total = def.steps.length;

  try {
    await callbacks.sendStatus(
      `🚀 <b>${def.name}</b> — ${total} step${total === 1 ? "" : "s"}\n` +
      def.steps.map((s, i) => `  ${i + 1}. ${s.label ?? s.id}`).join("\n"),
    );
  } catch { /* non-fatal */ }

  let stepsRun = 0;

  for (const [stepIndex, step] of def.steps.entries()) {
    const stepNum = stepIndex + 1;
    const label = step.label ?? step.id;

    try { await callbacks.sendStatus(`▶️ Step ${stepNum}/${total}: <b>${label}</b>`); } catch { /* non-fatal */ }

    const task = renderTemplate(step.task, params);
    log.info({ workflow: def.id, step: step.id, stepNum }, "Running workflow step");

    let ok: boolean;
    try {
      ok = await callbacks.runStep(task);
    } catch (err) {
      const errorMessage = (err as Error).message ?? String(err);
      const shortTask = step.task.substring(0, 30);
      const stepLabel = step.label ?? shortTask;

      try {
        await callbacks.sendStatus(
          `⚠️ Step ${stepNum} (<i>${stepLabel}</i>) failed: ${errorMessage}`,
        );
      } catch {
        // status reporting failure is non-fatal
      }
      log.warn({ workflow: def.id, step: step.id, err: errorMessage }, "Workflow step threw an error");

      stepsRun++;

      if (step.optional) {
        // Optional step — log and continue to the next step
        continue;
      }

      return { completed: false, stepsRun, abortedAt: step.id };
    }

    stepsRun++;

    if (!ok) {
      try { await callbacks.sendStatus(`⛔ Workflow <b>${def.name}</b> stopped at step ${stepNum} (<i>${label}</i>) — action was rejected or failed.`); } catch { /* non-fatal */ }
      log.info({ workflow: def.id, step: step.id }, "Workflow aborted");
      return { completed: false, stepsRun, abortedAt: step.id };
    }
  }

  try { await callbacks.sendStatus(`✅ <b>${def.name}</b> complete — all ${total} steps done.`); } catch { /* non-fatal */ }

  log.info({ workflow: def.id, stepsRun }, "Workflow completed");
  return { completed: true, stepsRun };
}

/**
 * Validate that all required params are present.
 * Returns a list of missing param names.
 */
export function validateParams(
  def: WorkflowDef,
  params: Record<string, string>,
): string[] {
  return def.params.filter((p) => !params[p]?.trim());
}
