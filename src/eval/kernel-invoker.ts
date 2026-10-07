/**
 * FounderOS v3 — eval invoker for the kernel.
 * ============================================
 * Adapts the compiled kernel to the eval runner's Invoker seam. Routing is
 * read from the VALIDATED plan (typed data), not parsed out of transfer-tool
 * prose like the old office-invoker had to.
 *
 * Tool observation (`tools`/`toolCalls`) has to survive TWO ways a step never
 * appears in the settled `res.results` array — both proven against the real
 * graph, not assumed (docs/EVAL-AUDIT-2026-08-28.md D1):
 *
 *  1. An EARLIER tool call in the same step already committed via a normal
 *     tools-node return before a LATER call in that step paused or the turn
 *     ended. That data lives in `state.step_receipts` (kernel/state.ts),
 *     which the old invoker never read.
 *  2. The paused call ITSELF never produces a receipt at all: every HITL tool
 *     in this codebase calls `interrupt()` BEFORE doing any work
 *     (src/infra/hitl.ts, "DB row BEFORE interrupt()"), so the tools node
 *     throws before its own receipt-recording line ever runs — verified
 *     empirically (buildKernel + a real gated tool: `step_receipts` is `{}`
 *     at the paused checkpoint when the gated call is the step's only call).
 *     The only record that the tool was ever called is the pending
 *     interrupt's own payload (`{ action: "<tool name>" }` —
 *     src/infra/hitl.ts `ApprovalRequest`).
 */

import { OFFICE_RECURSION_LIMIT } from "../core/config.js";
import { kernelCommand, type CompiledKernel } from "../kernel/index.js";
import type { Department, GoldenTask, Observation, PlanStepObservation, ToolCallObservation } from "./types.js";
import type { Invoker } from "./runner.js";
import type { UsageSource } from "./usage-collector.js";
import type { PriorTurn } from "./types.js";

/** Minimal checkpoint-write surface the history seeding needs (the compiled graph satisfies it). */
export interface SeedableKernel {
  updateState?(config: unknown, values: Record<string, unknown>, asNode?: string): Promise<unknown>;
}

/**
 * Put earlier turns into the thread's `history` channel, oldest first, one write per turn.
 * This is what the plan node does after a real turn, minus the model calls: the planner then
 * sees them the way it sees yesterday's chat in production. Timestamps stay a minute apart so
 * trimHistory's 6-hour gap rule keeps them all.
 */
export async function seedPriorTurns(
  kernel: SeedableKernel,
  config: unknown,
  threadId: string,
  turns: PriorTurn[],
): Promise<void> {
  if (turns.length === 0) return;
  if (!kernel.updateState) throw new Error("kernel cannot seed prior turns: no updateState");
  const now = Date.now();
  for (const [i, t] of turns.entries()) {
    await kernel.updateState(
      config,
      {
        history: [
          {
            turn_id: `${threadId}:prior:${i}`,
            at: new Date(now - (turns.length - i) * 60_000).toISOString(),
            user_input: t.user,
            goal: t.user.slice(0, 200),
            outcome: "replied",
            reply: t.reply,
          },
        ],
      },
      "plan",
    );
  }
}

let counter = 0;

/** Extract a pending interrupt's gated-tool name. Every HITL gate in this
 * codebase goes through hitlGate() (src/infra/hitl.ts), whose payload always
 * carries `action: string` — but the interrupt value is `unknown` by design
 * (any tool could in principle shape its own payload), so this stays defensive. */
function interruptedToolName(value: unknown): string | null {
  if (value && typeof value === "object" && typeof (value as { action?: unknown }).action === "string") {
    return (value as { action: string }).action;
  }
  return null;
}

/** Pass a usage collector (usage-collector.ts) to get every LLM call of a turn on observation.usage, failed turns included. */
export function makeKernelInvoker(kernel: CompiledKernel, usage?: UsageSource): Invoker {
  const runTurn: Invoker = async function invoke(task: GoldenTask): Promise<Observation> {
    const threadId = `eval:${Date.now()}:${counter++}`;
    // Match production's real recursion budget (src/gateway/kernel-run.ts et
    // al. all pass this on every invoke/getState). Without it the eval ran at
    // LangGraph's built-in default of 25, not this repo's configured 60 —
    // the likely cause of 3 "Recursion limit of 25 reached" failures in the
    // 2026-08-27 report (docs/EVAL-AUDIT-2026-08-28.md D5/LIMITATIONS.md B5).
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: OFFICE_RECURSION_LIMIT,
      ...(usage && { callbacks: [usage.callback] }),
    };
    try {
      await seedPriorTurns(kernel as unknown as SeedableKernel, config, threadId, task.priorTurns ?? []);
      const res = await kernel.invoke(
        {
          turn: {
            id: threadId,
            chat_id: "eval",
            received_at: new Date().toISOString(),
            raw_input: task.input,
          },
        },
        config,
      );

      const planSteps = res.mission.plan?.steps ?? [];
      const route = (planSteps[0]?.worker ?? null) as Department | null;
      const steps: PlanStepObservation[] = planSteps.map((s) => ({
        worker: s.worker as Department,
        objective: s.objective,
      }));

      const state = (await kernel.getState(config)) as {
        tasks?: Array<{ interrupts?: Array<{ value: unknown }> }>;
        values?: { step_receipts?: Record<string, Array<{ tool: string; ok: boolean }>> };
      };
      const pendingInterrupts = (state.tasks ?? []).flatMap((t) => t.interrupts ?? []);
      const hadInterrupt = pendingInterrupts.length > 0;

      const settledReceipts = res.results.flatMap((r) => ("tool_receipts" in r ? r.tool_receipts ?? [] : []));
      // step_receipts is keyed by step_id and only reset by the NEXT turn's
      // plan node, so within this one turn every entry belongs to a step of
      // THIS run regardless of whether that step ended ok, failed, or paused.
      const inFlightReceipts = Object.values(state.values?.step_receipts ?? {}).flat();
      const interruptedTools = pendingInterrupts
        .map((i) => interruptedToolName(i.value))
        .filter((name): name is string => name !== null);

      const toolCalls: ToolCallObservation[] = [
        ...settledReceipts.map((r) => ({ tool: r.tool, ok: r.ok })),
        ...inFlightReceipts.map((r) => ({ tool: r.tool, ok: r.ok })),
        // Paused-on-approval is the CORRECT behaviour for a gated tool, not a
        // failure — recorded ok:true so scoreToolSelection's name-presence
        // check sees it as observed without asserting the send is confirmed.
        ...interruptedTools.map((tool) => ({ tool, ok: true })),
      ];
      const tools = [...new Set(toolCalls.map((t) => t.tool))];

      return { route, tools, hadInterrupt, steps, toolCalls, command: kernelCommand(res as never), reply: res.reply };
    } catch (err) {
      return { route: null, tools: [], hadInterrupt: false, error: (err as Error).message };
    }
  };

  return async (task: GoldenTask): Promise<Observation> => {
    const obs = await runTurn(task);
    return usage ? { ...obs, usage: await usage.take() } : obs;
  };
}
