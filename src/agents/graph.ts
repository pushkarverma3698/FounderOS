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
import type { FounderStateType, DeptSignal } from "./state.js";
import { supervisorNode } from "./supervisor.js";
import { preRouterNode } from "./pre-router.js";
import { salesSubgraph } from "./pods/sales.js";
import { engineeringSubgraph } from "./pods/engineering.js";
import { marketingSubgraph } from "./pods/marketing.js";
import { socialSubgraph } from "./pods/social.js";
import { prospectingSubgraph } from "./pods/prospecting.js";
import type { ProspectingResult } from "./pods/prospecting.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "graph" });

// ── Pre-router edge: after preRouterNode ──────────────────────────────────────

/**
 * After the pre-router:
 *  - If department already set AND result is set (direct answer) → END (no pod needed)
 *  - If department is set but no result → go directly to that pod (skip CEO)
 *  - If department is empty → escalate to CEO supervisor
 */
function routeAfterPreRouter(
  state: FounderStateType,
): "supervisor" | "sales" | "engineering" | "marketing" | "social" | "prospecting" | typeof END {
  // Direct answer (small-talk / Q&A) — result already written, no pod needed
  const dept = state.department as string;
  if (state.result && !dept) {
    log.info("Pre-router: direct answer, routing to END");
    return END;
  }

  if (state.department === "sales") return "sales";
  if (state.department === "engineering") return "engineering";
  if (state.department === "marketing") return "marketing";
  if (state.department === "social") return "social";
  if (state.department === "prospecting") return "prospecting";

  // Ambiguous — escalate to CEO supervisor
  return "supervisor";
}

// ── Department router (pure function — used as conditional edge) ───────────────

function routeDepartment(
  state: FounderStateType,
): "sales" | "engineering" | "marketing" | "social" | "prospecting" | typeof END {
  if (state.department === "sales") return "sales";
  if (state.department === "engineering") return "engineering";
  if (state.department === "marketing") return "marketing";
  if (state.department === "social") return "social";
  if (state.department === "prospecting") return "prospecting";
  // Unknown department — end gracefully (supervisor logged warning)
  log.warn({ department: state.department }, "Unknown department — routing to END");
  return END;
}

// ── Post-prospecting router ────────────────────────────────────────────────────

/**
 * Pure function — routes after ProspectingPod completes.
 * Qualified lead (outreach_tier set) → sales pod.
 * Disqualified (outreach_tier null)  → END (Telegram daily digest picks it up).
 */
function routeAfterProspecting(
  state: FounderStateType,
): "sales" | typeof END {
  if (state.outreach_tier !== null) {
    log.info({ outreach_tier: state.outreach_tier }, "Lead qualified — routing to sales");
    return "sales";
  }
  log.info("Lead disqualified — routing to END");
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

// ── Prospecting node (custom — needs to surface outreach_tier into FounderState) ─

/**
 * Custom wrapper for ProspectingPod.
 * Unlike other pods (which only write `result`), this also writes `outreach_tier`
 * so that `routeAfterProspecting` can decide whether to hand off to SalesPod.
 *
 * The task field for prospecting contains the raw company URL or name, e.g.:
 *   { task: "https://acme.com", department: "prospecting" }
 */
async function prospectingNode(
  state: FounderStateType,
  config?: RunnableConfig,
): Promise<Partial<FounderStateType>> {
  log.info({ tenant_id: state.tenant_id }, "Invoking prospecting subgraph");

  const input = {
    raw_input: state.task,
    tenant_id: state.tenant_id,
    trace_id: state.trace_id,
  };

  const result = await prospectingSubgraph.invoke(input, config);

  const summary = {
    company_url: result.company_url,
    company_name: result.company_name,
    icp_score: result.icp_score,
    icp_rationale: result.icp_rationale,
    outreach_tier: result.outreach_tier,
    lead_id: result.lead_id,
  };

  // Phase 3C: emit in-process DeptSignal so supervisor/subsequent nodes can observe it
  const signal: DeptSignal = {
    from: "prospecting",
    event: result.outreach_tier ? "lead_qualified" : "lead_disqualified",
    payload: {
      company: result.company_name ?? result.company_url,
      icp_score: result.icp_score,
      outreach_tier: result.outreach_tier ?? null,
      lead_id: result.lead_id,
    },
    thread_id: `${state.tenant_id}:prospecting:${state.trace_id}`,
    ts: new Date().toISOString(),
  };

  return {
    result: JSON.stringify(summary, null, 2),
    outreach_tier: result.outreach_tier ?? null,
    departmentSignals: [signal],
  };
}

// ── Graph Definition ──────────────────────────────────────────────────────────

const graphBuilder = new StateGraph(FounderState)
  .addNode("pre_router", preRouterNode)
  .addNode("supervisor", supervisorNode)
  .addNode("sales", salesNode)
  .addNode("engineering", engineeringNode)
  .addNode("marketing", marketingNode)
  .addNode("social", socialNode)
  .addNode("prospecting", prospectingNode)

  // All tasks enter pre_router first (3-layer cheap classifier)
  .addEdge(START, "pre_router")

  // Pre-router decides: direct answer → END, confident dept → pod, ambiguous → CEO
  .addConditionalEdges("pre_router", routeAfterPreRouter, {
    supervisor: "supervisor",
    sales: "sales",
    engineering: "engineering",
    marketing: "marketing",
    social: "social",
    prospecting: "prospecting",
    [END]: END,
  })

  // CEO supervisor only runs for genuinely ambiguous tasks
  .addConditionalEdges("supervisor", routeDepartment, {
    sales: "sales",
    engineering: "engineering",
    marketing: "marketing",
    social: "social",
    prospecting: "prospecting",
    [END]: END,
  })

  // After prospecting: qualified → sales, disqualified → END
  .addConditionalEdges("prospecting", routeAfterProspecting, {
    sales: "sales",
    [END]: END,
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
  log.info("FounderGraph compiled with 5 departments: prospecting, sales, engineering, marketing, social");
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
