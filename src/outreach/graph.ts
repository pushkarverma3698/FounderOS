/**
 * Outreach reflection LangGraph — compile entry point.
 *
 * Flow:
 *   START → generator → validator ─┬→ executor → END
 *                                  ├→ reflector → validator (loop)
 *                                  └→ fail → END
 *
 * Inject models at build time so CI runs with scripted fakes at $0.
 */

import { StateGraph, START, END, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { OutreachReflectionGraphState, type OutreachGraphState } from "./state.js";
import { routeAfterValidator } from "./routing.js";
import {
  makeExecutorNode,
  makeFailNode,
  makeGeneratorNode,
  makeReflectorNode,
  makeValidatorNode,
  type OutreachNodeDeps,
} from "./nodes.js";
import { buildGeneratorModel, buildReflectorModel, type OutreachModelConfig } from "./models.js";
import { createInMemoryOutreachQueue, type OutreachQueue, type OutreachQueueEntry } from "./queue.js";
import { InMemoryDailyLimitTracker } from "./validator.js";
import type { LeadContext } from "./contracts.js";

/** Caller-facing result after `runOutreachReflection` completes. */
export interface OutreachRunResult {
  status: "queued" | "failed";
  draft: string;
  retry_count: number;
  validation_errors: string[];
  queue_id?: string;
  queue_entry?: OutreachQueueEntry;
  failure_reason?: string;
}

export interface BuildOutreachReflectionGraphOpts {
  modelConfig?: OutreachModelConfig;
  generatorModel?: BaseChatModel;
  reflectorModel?: BaseChatModel;
  dailyLimits?: InMemoryDailyLimitTracker;
  queue?: OutreachQueue;
  accountId?: string;
  checkpointer?: BaseCheckpointSaver;
}

export function buildOutreachReflectionGraph(opts: BuildOutreachReflectionGraphOpts = {}) {
  const deps: OutreachNodeDeps = {
    generatorModel: opts.generatorModel ?? buildGeneratorModel(opts.modelConfig),
    reflectorModel: opts.reflectorModel ?? buildReflectorModel(opts.modelConfig),
    dailyLimits: opts.dailyLimits ?? new InMemoryDailyLimitTracker(),
    queue: opts.queue ?? createInMemoryOutreachQueue(),
    accountId: opts.accountId ?? "default",
  };

  const graph = new StateGraph(OutreachReflectionGraphState)
    .addNode("generator", makeGeneratorNode(deps))
    .addNode("validator", makeValidatorNode(deps))
    .addNode("reflector", makeReflectorNode(deps))
    .addNode("executor", makeExecutorNode(deps))
    .addNode("fail", makeFailNode())
    .addEdge(START, "generator")
    .addEdge("generator", "validator")
    .addConditionalEdges("validator", routeAfterValidator, {
      reflector: "reflector",
      executor: "executor",
      end: "fail",
    })
    .addEdge("reflector", "validator")
    .addEdge("executor", END)
    .addEdge("fail", END);

  return opts.checkpointer ? graph.compile({ checkpointer: opts.checkpointer }) : graph.compile();
}

export type CompiledOutreachReflectionGraph = ReturnType<typeof buildOutreachReflectionGraph>;

/** Convenience runner for Nest/Next API routes or scripts. */
export async function runOutreachReflection(
  lead: LeadContext,
  opts: BuildOutreachReflectionGraphOpts = {},
): Promise<OutreachRunResult> {
  const queue = opts.queue ?? createInMemoryOutreachQueue();
  const graph = buildOutreachReflectionGraph({ ...opts, queue });
  const state = (await graph.invoke({
    lead_context: lead,
    messages: [],
    current_draft: "",
    validation_errors: [],
    retry_count: 0,
    status: "running",
  })) as OutreachGraphState;

  const queueEntry = state.queue_id ? queue.get(state.queue_id) : undefined;
  return {
    status: state.status === "queued" ? "queued" : "failed",
    draft: state.current_draft,
    retry_count: state.retry_count,
    validation_errors: state.validation_errors,
    queue_id: state.queue_id,
    queue_entry: queueEntry,
    failure_reason: state.failure_reason,
  };
}
