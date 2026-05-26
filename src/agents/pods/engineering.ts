/**
 * FounderOS — Engineering Pod
 * ============================
 * Graph: spec → senior_dev → qa_tester → critic → [HITL] → finalize
 *
 * Phase 1C: Full implementation
 * Phase 1B: Non-throwing stubs — graph flows through, returns placeholder output
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { EngineeringState } from "../state.js";
import type { EngineeringStateType } from "../state.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "engineering_pod" });

async function seniorDevNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  log.info({ task: state.task.slice(0, 60) }, "Engineering pod: senior_dev (Phase 1C stub)");
  return {
    code_draft: `// Engineering pod stub — Phase 1C not yet implemented
// Task: ${state.task}
// TODO: implement senior_dev agent`,
    spec: state.task,
  };
}

async function qaTesterNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  log.info({}, "Engineering pod: qa_tester (Phase 1C stub)");
  return {
    test_results: {
      passed: true,
      details: "Phase 1C stub — QA not yet implemented",
    },
  };
}

async function hitlNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  log.info({}, "Engineering pod: hitl (Phase 1C stub)");
  return {
    hitl: {
      status: "pending",
      interrupt_id: "stub-" + Date.now(),
      requested_at: new Date().toISOString(),
    },
  };
}

async function finalizeNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  log.info({}, "Engineering pod: finalize (Phase 1C stub)");
  return {
    final: {
      code_draft: state.code_draft,
      test_results: state.test_results,
      finalized_at: new Date().toISOString(),
      phase: "1B_stub",
    },
  };
}

const engineeringGraph = new StateGraph(EngineeringState)
  .addNode("senior_dev", seniorDevNode)
  .addNode("qa_tester", qaTesterNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "senior_dev")
  .addEdge("senior_dev", "qa_tester")
  .addEdge("qa_tester", "hitl_gate")
  .addEdge("hitl_gate", "finalize")
  .addEdge("finalize", END);

export const engineeringSubgraph = engineeringGraph.compile();
