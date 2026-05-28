/**
 * FounderOS — Marketing Pod
 * ==========================
 * Graph: mktg_engineer → researcher → content_writer → critic → [HITL] → publish
 *
 * Phase 2E: mktg_engineer added as first node — owns campaign strategy.
 *   mktg_engineer:  Decide goal, pillar, platform, format, content brief (MD tier)
 *   researcher:     Gather trend context and relevant data (stub, Phase 3)
 *   content_writer: Execute the brief — produce the content draft (stub, Phase 3)
 *   hitl_gate:      Human approval before external post/publish
 *   publish:        Audit log + mark ready for LinkedIn / Instagram send
 *
 * Rule: HITL gates ONLY external posts and public-facing sends.
 * mktg_engineer decisions (strategy, angle, brief) are autonomous.
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { MarketingState } from "../state.js";
import type { MarketingStateType } from "../state.js";
import { callCascade, checkBudget, safeParseJson } from "../../infra/llm.js";
import { requestHITL } from "../../gateway/hitl.js";
import { hasBeenAudited, writeAuditEntry, writeTaskOutcome, getRecentOutcomes } from "../../db/queries.js";
import { getSystem } from "../../core/prompts.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "marketing_pod" });

// ── Marketing Engineer Node ───────────────────────────────────────────────────

/**
 * mktg_engineer — first node in the pod.
 * Plans campaign strategy autonomously. No HITL for planning.
 * Output: mktg_engineer_brief with goal, pillar, platform, format, and content brief.
 */
async function mktgEngineerNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  const tenantId = state.tenant_id;
  await checkBudget(tenantId);

  // Inject few-shot examples from past outcomes (self-improvement loop)
  const pastOutcomes = await getRecentOutcomes("mktg_engineer").catch(() => []);
  const fewShotBlock = pastOutcomes.length > 0
    ? "\n\nPAST CAMPAIGN EXAMPLES (learn from these — real outcomes):\n" +
      pastOutcomes
        .map((o) => `[${o.outcome.toUpperCase()}] ${o.decision_summary ?? "no summary"}`)
        .join("\n")
    : "";

  const basePrompt = getSystem("MKTG_ENGINEER");
  const systemPrompt = basePrompt + fewShotBlock;

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`MARKETING TASK:\n${state.task}\n\nPlan the campaign strategy. Return your JSON brief.`),
  ];

  const result = await callCascade(
    "md",
    messages,
    { agent: "mktg_engineer", tenant_id: tenantId },
  );

  let mktg_engineer_brief: MarketingStateType["mktg_engineer_brief"] = null;

  try {
    mktg_engineer_brief = safeParseJson<NonNullable<MarketingStateType["mktg_engineer_brief"]>>(result.text);
    log.info(
      {
        goal: mktg_engineer_brief?.goal,
        pillar: mktg_engineer_brief?.pillar,
        platform: mktg_engineer_brief?.platform,
        format: mktg_engineer_brief?.format,
      },
      "Marketing strategy brief ready",
    );
  } catch {
    log.warn({ raw: result.text.slice(0, 200) }, "Mktg engineer parse failed — proceeding without brief");
  }

  return { mktg_engineer_brief };
}

// ── Researcher Node ───────────────────────────────────────────────────────────

/**
 * researcher — gathers trend context based on mktg_engineer brief.
 * Phase 3: will use Tavily search + LinkedIn trend data.
 * Phase 2E: stub that acknowledges the strategy.
 */
async function researcherNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  const brief = state.mktg_engineer_brief;

  if (brief) {
    log.info({ pillar: brief.pillar, platform: brief.platform }, "Marketing pod: researcher (strategy-aware)");
    return {
      trend_report: `Marketing strategy: ${brief.pillar} | Goal: ${brief.goal} | Platform: ${brief.platform}\n\nContent brief: ${brief.content_brief}\n\nPhase 3: real trend research via Tavily will be added here.`,
    };
  }

  log.info({ task: state.task.slice(0, 60) }, "Marketing pod: researcher (no strategy brief)");
  return {
    trend_report: `Marketing pod stub — Task: ${state.task}`,
  };
}

// ── Content Writer Node ───────────────────────────────────────────────────────

/**
 * content_writer — produces platform-ready content following mktg_engineer brief.
 * Calls MD-tier LLM with brief context, hook strategy, and platform constraints.
 * Fail-open: if LLM returns empty, falls back to a descriptive placeholder.
 */
async function contentWriterNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  const brief = state.mktg_engineer_brief;
  const tenantId = state.tenant_id;

  log.info({ format: brief?.format, platform: brief?.platform }, "Marketing pod: content_writer");

  await checkBudget(tenantId);

  const systemPrompt = getSystem("CONTENT_WRITER");

  const briefSection = brief
    ? `CAMPAIGN BRIEF:
Platform: ${brief.platform}
Format: ${brief.format}
Goal: ${brief.goal}
Content Pillar: ${brief.pillar}
Hook Strategy: ${brief.hook_strategy}
Target Emotion: ${brief.target_emotion}
Content Brief: ${brief.content_brief}`
    : `TASK: ${state.task}`;

  const trendSection = state.trend_report
    ? `\n\nTREND CONTEXT:\n${state.trend_report.slice(0, 400)}`
    : "";

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`${briefSection}${trendSection}\n\nWrite the content now. Output the post directly — no preamble, no JSON.`),
  ];

  const result = await callCascade(
    "md",
    messages,
    { agent: "content_writer", tenant_id: tenantId },
  );

  const content_draft = result.text.trim() ||
    (brief
      ? `[Content draft for ${brief.platform} — ${brief.format} — Goal: ${brief.goal}]`
      : `[Content draft for task: ${state.task.slice(0, 80)}]`);

  log.info({ chars: content_draft.length, platform: brief?.platform }, "Content draft ready");

  return { content_draft };
}

// ── HITL Node ─────────────────────────────────────────────────────────────────

/**
 * HITL gate — required before every external post/publish.
 * Marketing posts are external-facing actions, so HITL is always required here.
 */
async function hitlNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  const brief = state.mktg_engineer_brief;
  const summary = brief
    ? `Marketing content ready for ${brief.platform}.\nPillar: ${brief.pillar} | Goal: ${brief.goal} | Format: ${brief.format}`
    : `Marketing content ready for approval.\nTask: ${state.task}`;

  const draft = state.content_draft ?? "(no content draft yet)";

  const hitl = await requestHITL({
    thread_id: `${state.tenant_id}:marketing:${state.trace_id}`,
    tenant_id: state.tenant_id,
    agent: "mktg_engineer",
    summary,
    draft,
    ttl_minutes: 120,
  });

  log.info({ interrupt_id: hitl.interrupt_id }, "Marketing HITL requested");

  return { hitl };
}

// ── Publish Node ──────────────────────────────────────────────────────────────

async function publishNode(state: MarketingStateType): Promise<Partial<MarketingStateType>> {
  const idempotencyKey = `mktg_draft_ready:${state.trace_id}`;

  const alreadyPublished = await hasBeenAudited(idempotencyKey).catch((err) => {
    log.warn({ err: (err as NodeJS.ErrnoException).code ?? String(err), idempotency_key: idempotencyKey }, "hasBeenAudited DB unavailable — treating as not audited");
    return false;
  });

  if (alreadyPublished) {
    log.info({ idempotency_key: idempotencyKey }, "Already published — skipping");
    return {};
  }

  await writeAuditEntry({
    tenant_id: state.tenant_id,
    action: "mktg_draft_ready",
    idempotency_key: idempotencyKey,
    payload: {
      task: state.task.slice(0, 100),
      goal: state.mktg_engineer_brief?.goal ?? null,
      pillar: state.mktg_engineer_brief?.pillar ?? null,
      platform: state.mktg_engineer_brief?.platform ?? null,
      hitl_interrupt_id: state.hitl?.interrupt_id ?? null,
    },
  }).catch((err) => {
    log.warn({ err: (err as NodeJS.ErrnoException).code ?? String(err) }, "writeAuditEntry failed — non-blocking");
  });

  const outcome = state.hitl?.status === "rejected" ? "hitl_rejected" : "succeeded";

  // Self-improvement: write task outcome for few-shot injection in future runs
  writeTaskOutcome({
    tenant_id: state.tenant_id,
    agent_id: "mktg_engineer",
    thread_id: `${state.tenant_id}:marketing:${state.trace_id}`,
    lead_id: null,
    outcome,
    decision_summary: state.mktg_engineer_brief
      ? `${state.mktg_engineer_brief.pillar} | ${state.mktg_engineer_brief.platform} | ${state.mktg_engineer_brief.format} | Goal: ${state.mktg_engineer_brief.goal}`
      : `Task: ${state.task.slice(0, 120)}`,
    tools_used: ["mktg_engineer_node", "researcher", "content_writer"],
    user_feedback: state.hitl?.rejection_reason ?? null,
    cost_usd: null,
    latency_ms: null,
  }).catch((err) => log.warn({ err: (err as Error).message }, "writeTaskOutcome failed — non-blocking"));

  log.info({ task: state.task.slice(0, 60), outcome }, "Marketing content finalized");

  return {
    final: {
      brief: state.mktg_engineer_brief,
      content_draft: state.content_draft,
      hitl_status: state.hitl?.status ?? "pending",
      finalized_at: new Date().toISOString(),
    },
  };
}

// ── Graph definition ──────────────────────────────────────────────────────────

const marketingGraph = new StateGraph(MarketingState)
  .addNode("mktg_engineer_node", mktgEngineerNode)
  .addNode("researcher", researcherNode)
  .addNode("content_writer", contentWriterNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("publish", publishNode)
  .addEdge(START, "mktg_engineer_node")
  .addEdge("mktg_engineer_node", "researcher")
  .addEdge("researcher", "content_writer")
  .addEdge("content_writer", "hitl_gate")
  .addEdge("hitl_gate", "publish")
  .addEdge("publish", END);

export const marketingSubgraph = marketingGraph.compile();
