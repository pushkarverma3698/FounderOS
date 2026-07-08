/**
 * FounderOS v3 kernel — graph assembly.
 * ======================================
 * plan (LLM) → dispatch (pure) → agent (LLM) ⇄ tools → collect (pure)
 *                     ↑______________________________________|
 *                     └→ synthesize (LLM) → END      └→ finish (failure reply)
 *
 * Everything is injected (models, worker specs, checkpointer) — the kernel
 * never constructs a provider client or reads env, which is what makes the
 * full graph runnable offline in CI at $0 and swappable in production.
 *
 * Known limitation (by design, Phase 4 wires it): cross-turn conversational
 * context comes from durable memory via the composition root, not from
 * replaying chat history into the planner.
 */

import { StateGraph, START, END, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { KernelState, type KernelStateType } from "./state.js";
import { makePlanNode, type KernelChatModel, type WorkerCatalogEntry } from "./planner.js";
import { dispatch, routeAfterDispatch, routeAfterPlan } from "./supervisor.js";
import { makeAgentNode, makeToolsNode, routeAfterAgent, collect, type KernelBindableModel, type WorkerSpec } from "./worker.js";
import { makeSynthesizeNode } from "./synthesizer.js";

export interface KernelConfig {
  plannerModel: KernelChatModel;
  workerModel: KernelBindableModel;
  synthesizerModel: KernelChatModel;
  workers: WorkerSpec[];
  checkpointer?: BaseCheckpointSaver;
}

export function buildKernel(config: KernelConfig) {
  const specs: Record<string, WorkerSpec> = Object.fromEntries(config.workers.map((w) => [w.id, w]));
  const catalog: WorkerCatalogEntry[] = config.workers.map((w) => ({
    id: w.id,
    description: w.description,
    toolNames: w.tools.map((t) => t.name),
    // Gated tools are declared via name convention at the composition root
    // (Phase 4 passes the real HITL registry); the planner prompt only needs names.
    gatedToolNames: [],
  }));

  const graph = new StateGraph(KernelState)
    .addNode("plan", makePlanNode(config.plannerModel, catalog))
    .addNode("dispatch", dispatch)
    .addNode("agent", makeAgentNode(config.workerModel, specs))
    .addNode("tools", makeToolsNode(specs))
    .addNode("collect", collect)
    .addNode("synthesize", makeSynthesizeNode(config.synthesizerModel))
    .addEdge(START, "plan")
    .addConditionalEdges("plan", routeAfterPlan, { dispatch: "dispatch", finish: END })
    .addConditionalEdges("dispatch", routeAfterDispatch, { agent: "agent", synthesize: "synthesize", finish: END })
    .addConditionalEdges("agent", routeAfterAgent, { tools: "tools", collect: "collect" })
    .addEdge("tools", "agent")
    .addEdge("collect", "dispatch")
    .addEdge("synthesize", END);

  return config.checkpointer ? graph.compile({ checkpointer: config.checkpointer }) : graph.compile();
}

export type CompiledKernel = ReturnType<typeof buildKernel>;

/**
 * After an invoke, surface a pending HITL approval (graph paused inside a
 * gated tool). Mirrors the old office helper so the gateway swap is 1:1.
 */
export async function getPendingKernelApproval(
  kernel: { getState: (c: RunnableConfig) => Promise<unknown> },
  config: RunnableConfig,
): Promise<unknown | null> {
  const state = (await kernel.getState(config)) as {
    tasks?: Array<{ interrupts?: Array<{ value: unknown }> }>;
  };
  const interrupts = (state.tasks ?? []).flatMap((t) => t.interrupts ?? []);
  return interrupts.length > 0 ? interrupts[0]!.value : null;
}

/** The founder-facing reply for a completed turn. */
export function kernelReply(state: KernelStateType): string {
  return state.reply || "⚠️ No reply produced — mission state: " + state.mission.status;
}
