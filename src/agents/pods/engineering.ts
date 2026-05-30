/**
 * FounderOS — Engineering Pod
 * ============================
 * Graph: eng_engineer → senior_dev → qa_tester → critic → [HITL] → finalize
 *
 * Phase 2E: eng_engineer added as first node — owns technical planning.
 *   eng_engineer: Decompose task, identify risks, plan execution steps (MD tier)
 *   senior_dev:   Execute the plan — write code (CODE tier stub, Phase 3)
 *   qa_tester:    Validate output (stub, Phase 3)
 *   hitl_gate:    Human approval before external push (GitHub, prod deploy)
 *   finalize:     Audit log + mark ready for delivery
 *
 * Rule: HITL gates ONLY external actions (GitHub push, prod deploy, client handoff).
 * eng_engineer decisions are autonomous — no HITL for internal planning/analysis.
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { EngineeringState } from "../state.js";
import type { EngineeringStateType } from "../state.js";
import { callCascade, checkBudget, safeParseJson } from "../../infra/llm.js";
import { requestHITL } from "../../gateway/hitl.js";
import { hasBeenAudited, writeAuditEntry, writeTaskOutcome, getRecentOutcomes } from "../../db/queries.js";
import { getSystem } from "../../core/prompts.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "engineering_pod" });

// ── Engineering Engineer Node ─────────────────────────────────────────────────

/**
 * eng_engineer — first node in the pod.
 * Plans technical approach autonomously. No HITL for planning.
 * Output: eng_engineer_plan with steps, risks, and first deliverable.
 */
async function engEngineerNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  const tenantId = state.tenant_id;
  await checkBudget(tenantId);

  // Inject few-shot examples from past outcomes (self-improvement loop)
  const pastOutcomes = await getRecentOutcomes("eng_engineer").catch(() => []);
  const fewShotBlock = pastOutcomes.length > 0
    ? "\n\nPAST ENGINEERING PLANS (learn from these — real outcomes):\n" +
      pastOutcomes
        .map((o) => `[${o.outcome.toUpperCase()}] ${o.decision_summary ?? "no summary"}`)
        .join("\n")
    : "";

  const basePrompt = getSystem("ENG_ENGINEER");
  const systemPrompt = basePrompt + fewShotBlock;

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`ENGINEERING TASK:\n${state.task}\n\nPlan the execution. Return your JSON plan.`),
  ];

  let eng_engineer_plan: EngineeringStateType["eng_engineer_plan"] = null;
  let spec: string | null = null;

  try {
    const result = await callCascade(
      "md",
      messages,
      { agent: "eng_engineer", tenant_id: tenantId },
    );
    eng_engineer_plan = safeParseJson<NonNullable<EngineeringStateType["eng_engineer_plan"]>>(result.text);
    spec = eng_engineer_plan?.summary ?? state.task;
    log.info(
      {
        summary: eng_engineer_plan?.summary,
        step_count: eng_engineer_plan?.steps?.length ?? 0,
        estimated_hours: eng_engineer_plan?.estimated_hours,
      },
      "Engineering plan ready",
    );
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "eng_engineer" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "eng_engineer", err: String(err) }],
      };
    }
    log.warn({ raw: String(err) }, "Eng engineer parse failed — using task as spec");
    spec = state.task;
  }

  return { eng_engineer_plan, spec };
}

// ── Senior Dev Node ───────────────────────────────────────────────────────────

/**
 * senior_dev — executes the engineering plan produced by eng_engineer.
 * Calls CODE-tier LLM to produce actual TypeScript code for the first deliverable.
 */
async function seniorDevNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  const tenantId = state.tenant_id;
  await checkBudget(tenantId);

  const plan = state.eng_engineer_plan;
  const planContext = plan
    ? `ENGINEERING PLAN:
Summary: ${plan.summary}
First Deliverable: ${plan.first_deliverable}
Steps:
${plan.steps.map((s, i) => `  ${i + 1}. ${s.action} (tier: ${s.tier}${s.tool ? `, tool: ${s.tool}` : ""})`).join("\n")}
Risks: ${plan.risks.join("; ") || "none identified"}
Estimated Hours: ${plan.estimated_hours}h`
    : `TASK (no structured plan): ${state.task}`;

  const messages = [
    new SystemMessage(getSystem("SENIOR_DEV")),
    new HumanMessage(
      `${planContext}\n\nORIGINAL TASK:\n${state.task}\n\nImplement the first deliverable. Write complete, working TypeScript code.`,
    ),
  ];

  log.info(
    { summary: plan?.summary ?? state.task.slice(0, 60), steps: plan?.steps.length ?? 0 },
    "Engineering pod: senior_dev generating code",
  );

  let code_draft: string | null = null;

  try {
    const result = await callCascade(
      "code",
      messages,
      { agent: "senior_dev", tenant_id: tenantId },
    );
    log.info(
      { lines: result.text.split("\n").length, model: result.model },
      "senior_dev code draft ready",
    );
    code_draft = result.text;
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "senior_dev" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "senior_dev", err: String(err) }],
      };
    }
    log.warn({ raw: String(err) }, "Senior dev cascade failed — empty draft");
    code_draft = "// Code generation unavailable — LLM error";
  }

  return { code_draft };
}

// ── QA Tester Node ────────────────────────────────────────────────────────────

async function qaTesterNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  log.info({}, "Engineering pod: qa_tester");
  return {
    test_results: {
      passed: true,
      details: `QA stub — Phase 3 implementation pending. Plan: ${state.eng_engineer_plan?.summary ?? "N/A"}`,
    },
  };
}

// ── HITL Node ─────────────────────────────────────────────────────────────────

/**
 * HITL gate — only triggered for external actions (GitHub push, prod deploy, client handoff).
 * Internal analysis and code review do NOT require HITL approval.
 */
async function hitlNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  const plan = state.eng_engineer_plan;
  const hasExternalAction = plan?.steps.some((s) => s.hitl_required) ?? false;

  if (!hasExternalAction) {
    log.info({}, "Engineering HITL: no external action required — auto-proceeding");
    return {
      hitl: {
        status: "approved",
        interrupt_id: `auto-${Date.now()}`,
        requested_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      },
    };
  }

  const summary = `Engineering task ready for external delivery.\nPlan: ${plan?.summary ?? state.task}\nFirst deliverable: ${plan?.first_deliverable ?? "TBD"}`;
  const draft = state.code_draft ?? "(no code draft yet)";

  const hitl = await requestHITL({
    thread_id: `${state.tenant_id}:engineering:${state.trace_id}`,
    tenant_id: state.tenant_id,
    agent: "eng_engineer",
    summary,
    draft,
    ttl_minutes: 120,
  });

  log.info({ interrupt_id: hitl.interrupt_id }, "Engineering HITL requested");

  return { hitl };
}

// ── Finalize Node ─────────────────────────────────────────────────────────────

async function finalizeNode(state: EngineeringStateType): Promise<Partial<EngineeringStateType>> {
  const idempotencyKey = `eng_draft_ready:${state.trace_id}`;

  // Fail-open: if DB is unavailable, treat as "not yet audited" and proceed
  const alreadyAudited = await hasBeenAudited(idempotencyKey).catch((err) => {
    log.warn({ err: (err as NodeJS.ErrnoException).code ?? String(err), idempotency_key: idempotencyKey }, "hasBeenAudited DB unavailable — treating as not audited");
    return false;
  });

  if (alreadyAudited) {
    log.info({ idempotency_key: idempotencyKey }, "Already finalized — skipping");
    return {};
  }

  await writeAuditEntry({
    tenant_id: state.tenant_id,
    action: "eng_draft_ready",
    idempotency_key: idempotencyKey,
    payload: {
      task: state.task.slice(0, 100),
      plan_summary: state.eng_engineer_plan?.summary ?? null,
      estimated_hours: state.eng_engineer_plan?.estimated_hours ?? null,
      hitl_interrupt_id: state.hitl?.interrupt_id ?? null,
    },
  }).catch((err) => {
    log.warn({ err: (err as NodeJS.ErrnoException).code ?? String(err) }, "writeAuditEntry failed — non-blocking");
  });

  const outcome = state.hitl?.status === "rejected" ? "hitl_rejected" : "succeeded";

  // Self-improvement: write task outcome for few-shot injection in future runs
  writeTaskOutcome({
    tenant_id: state.tenant_id,
    agent_id: "eng_engineer",
    thread_id: `${state.tenant_id}:engineering:${state.trace_id}`,
    lead_id: null,
    outcome,
    decision_summary: state.eng_engineer_plan
      ? `Plan: ${state.eng_engineer_plan.summary} | Steps: ${state.eng_engineer_plan.steps.length} | ~${state.eng_engineer_plan.estimated_hours}h`
      : `Task: ${state.task.slice(0, 120)}`,
    tools_used: ["eng_engineer_node", "senior_dev", "qa_tester"],
    user_feedback: state.hitl?.rejection_reason ?? null,
    cost_usd: null,
    latency_ms: null,
  }).catch((err) => log.warn({ err: (err as Error).message }, "writeTaskOutcome failed — non-blocking"));

  log.info({ task: state.task.slice(0, 60), outcome }, "Engineering task finalized");

  return {
    final: {
      plan: state.eng_engineer_plan,
      code_draft: state.code_draft,
      test_results: state.test_results,
      hitl_status: state.hitl?.status ?? "approved",
      finalized_at: new Date().toISOString(),
    },
  };
}

// ── Graph definition ──────────────────────────────────────────────────────────

const engineeringGraph = new StateGraph(EngineeringState)
  .addNode("eng_engineer_node", engEngineerNode)
  .addNode("senior_dev", seniorDevNode)
  .addNode("qa_tester", qaTesterNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "eng_engineer_node")
  .addEdge("eng_engineer_node", "senior_dev")
  .addEdge("senior_dev", "qa_tester")
  .addEdge("qa_tester", "hitl_gate")
  .addEdge("hitl_gate", "finalize")
  .addEdge("finalize", END);

export const engineeringSubgraph = engineeringGraph.compile();
