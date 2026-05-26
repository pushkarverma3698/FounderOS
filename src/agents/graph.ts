/**
 * FounderOS — Main FounderGraph
 * ==============================
 * Compiled ONCE at module load. Never compile per request.
 *
 * Architecture:
 *   CEO supervisor → conditional routing → department pod
 *   Each pod is invoked as a function (subgraph with own state).
 *
 * Departments: sales | engineering | marketing | social
 *
 * Subgraph state mapping:
 *   Pod subgraphs differ from FounderState.
 *   Wrapper nodes extract relevant fields, invoke subgraph, map result back.
 *
 * Simplification note (Architecture Review §3):
 *   The three copy-paste wrapper nodes have been replaced with one
 *   makePodNode() factory — 40+ lines saved, single point of change.
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { FounderState } from "./state.js";
import type { FounderStateType } from "./state.js";
import { supervisorNode } from "./supervisor.js";
import { salesSubgraph } from "./pods/sales.js";
import { engineeringSubgraph } from "./pods/engineering.js";
import { marketingSubgraph } from "./pods/marketing.js";
import { socialSubgraph } from "./pods/social.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "graph" });

// ── Department router (pure function — used as conditional edge) ───────────────

function routeDepartment(
  state: FounderStateType,
): "sales" | "engineering" | "marketing" | "social" | typeof END {
  if (state.department === "sales") return "sales";
  if (state.department === "engineering") return "engineering";
  if (state.department === "marketing") return "marketing";
  if (state.department === "social") return "social";
  // Unknown department — end gracefully (supervisor logged warning)
  log.warn({ department: state.department }, "Unknown department — routing to END");
  return END;
}

// ── Pod node factory ──────────────────────────────────────────────────────────

/**
 * Creates a LangGraph node that invokes a pod subgraph.
 * Handles state mapping in/out, reducing copy-paste across departments.
 *
 * @param subgraph   The compiled pod subgraph
 * @param getFinal   Extract the final output from the pod result
 * @param label      Log label for this pod
 */
function makePodNode<TResult extends Record<string, unknown>>(
  subgraph: { invoke: (input: Record<string, unknown>, config?: RunnableConfig) => Promise<TResult> },
  getFinal: (result: TResult) => unknown,
  label: string,
) {
  return async function podNode(
    state: FounderStateType,
    config?: RunnableConfig,
  ): Promise<Partial<FounderStateType>> {
    log.info({ tenant_id: state.tenant_id, department: label }, "Invoking pod subgraph");

    const input = {
      task: state.task,
      tenant_id: state.tenant_id,
      trace_id: state.trace_id,
      company: state.tenant_id,
    };

    const result = await subgraph.invoke(input, config);
    const finalOutput = getFinal(result);

    return {
      result: JSON.stringify(finalOutput ?? { status: "no_output" }, null, 2),
    };
  };
}

// ── Compiled pod nodes ────────────────────────────────────────────────────────

const salesNode = makePodNode(
  salesSubgraph,
  (r) => r.final ?? r.email_draft,
  "sales",
);

const engineeringNode = makePodNode(
  engineeringSubgraph,
  (r) => r.final ?? r.code_draft,
  "engineering",
);

const marketingNode = makePodNode(
  marketingSubgraph,
  (r) => r.final ?? r.content_draft,
  "marketing",
);

const socialNode = makePodNode(
  socialSubgraph,
  (r) => r.final ?? r.published_post ?? r.post_draft,
  "social",
);

// ── Graph Definition ──────────────────────────────────────────────────────────

const graphBuilder = new StateGraph(FounderState)
  .addNode("supervisor", supervisorNode)
  .addNode("sales", salesNode)
  .addNode("engineering", engineeringNode)
  .addNode("marketing", marketingNode)
  .addNode("social", socialNode)

  .addEdge(START, "supervisor")

  .addConditionalEdges("supervisor", routeDepartment, {
    sales: "sales",
    engineering: "engineering",
    marketing: "marketing",
    social: "social",
  })

  .addEdge("sales", END)
  .addEdge("engineering", END)
  .addEdge("marketing", END)
  .addEdge("social", END);

// ── Singleton compiled graph ──────────────────────────────────────────────────

let _graph: Awaited<ReturnType<typeof buildGraph>> | undefined;

async function buildGraph() {
  const checkpointer = await getCheckpointer();
  const compiled = graphBuilder.compile({ checkpointer });
  log.info("FounderGraph compiled with 4 departments: sales, engineering, marketing, social");
  return compiled;
}

/**
 * Get the compiled FounderGraph singleton.
 * First call initializes the checkpointer (async).
 * Subsequent calls return the cached instance.
 */
export async function getGraph(): Promise<typeof _graph> {
  if (!_graph) {
    _graph = await buildGraph();
  }
  return _graph;
}
