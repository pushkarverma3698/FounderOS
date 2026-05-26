/**
 * FounderOS — Marketing Pod
 * ==========================
 * Graph: social_researcher → content_writer → critic → [HITL] → publish
 *
 * Phase 1C: Full implementation
 * Phase 1B: Non-throwing stubs — graph flows through, returns placeholder output
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { MarketingState } from "../state.js";
import type { MarketingStateType } from "../state.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "marketing_pod" });

async function researcherNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  log.info({ task: state.task.slice(0, 60) }, "Marketing pod: researcher (Phase 1C stub)");
  return {
    trend_report: `Marketing pod stub — Phase 1C not yet implemented\nTask: ${state.task}`,
  };
}

async function contentWriterNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  log.info({}, "Marketing pod: content_writer (Phase 1C stub)");
  return {
    content_draft: `// Content draft stub\nBased on trend report: ${state.trend_report?.slice(0, 80) ?? "N/A"}\n\nPhase 1C: Full content generation not yet implemented.`,
  };
}

async function hitlNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  log.info({}, "Marketing pod: hitl (Phase 1C stub)");
  return {
    hitl: {
      status: "pending",
      interrupt_id: "stub-" + Date.now(),
      requested_at: new Date().toISOString(),
    },
  };
}

async function publishNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  log.info({}, "Marketing pod: publish (Phase 1C stub)");
  return {
    final: {
      content_draft: state.content_draft,
      finalized_at: new Date().toISOString(),
      phase: "1B_stub",
    },
  };
}

const marketingGraph = new StateGraph(MarketingState)
  .addNode("researcher", researcherNode)
  .addNode("content_writer", contentWriterNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("publish", publishNode)
  .addEdge(START, "researcher")
  .addEdge("researcher", "content_writer")
  .addEdge("content_writer", "hitl_gate")
  .addEdge("hitl_gate", "publish")
  .addEdge("publish", END);

export const marketingSubgraph = marketingGraph.compile();
