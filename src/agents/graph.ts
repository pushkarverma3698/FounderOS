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
import { salesSubgraph } from "./pods/sales.js";
import { engineeringSubgraph } from "./pods/engineering.js";
import { marketingSubgraph } from "./pods/marketing.js";
import { socialSubgraph } from "./pods/social.js";
import { prospectingSubgraph } from "./pods/prospecting.js";
import type { ProspectingResult } from "./pods/prospecting.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "graph" });

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
  .addNode("supervisor", supervisorNode)
  .addNode("sales", salesNode)
  .addNode("engineering", engineeringNode)
  .addNode("marketing", marketingNode)
  .addNode("social", socialNode)
  .addNode("prospecting", prospectingNode)

  .addEdge(START, "supervisor")

  .addConditionalEdges("supervisor", routeDepartment, {
    sales: "sales",
    engineering: "engineering",
    marketing: "marketing",
    social: "social",
    prospecting: "prospecting",
    // routeDepartment returns END when the supervisor cannot resolve a
    // department. Without this mapping LangGraph throws "Branch condition
    // returned unknown or null destination" and crashes the whole invocation
    // instead of ending gracefully (CEO live battery, 2026-05-31).
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
