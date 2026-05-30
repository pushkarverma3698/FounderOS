/**
 * FounderOS — Sales Pod
 * ======================
 * Graph: lead_intel → bdr → critic → [HITL] → finalize
 *
 * Agents:
 *  - lead_intel: Research the prospect company + score ICP fit
 *  - bdr:        Write personalized outreach email/DM
 *  - critic:     Quality gate (Claude critiques Gemini output — anti-sycophancy)
 *  - hitl:       Human approval gate (DB-backed, Telegram in Phase 1C)
 *  - finalize:   Audit log + mark draft ready for send
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { SalesState } from "../state.js";
import type { SalesStateType, LeadProfile } from "../state.js";
import { callCascade, checkBudget, safeParseJson } from "../../infra/llm.js";
import { requestHITL } from "../../gateway/hitl.js";
import { hasBeenAudited, writeAuditEntry, isSuppressed, writeTaskOutcome, getRecentOutcomes, publishDeptEvent } from "../../db/queries.js";
import { criticNode, afterCriticEdge } from "../critic.js";
import { getCompany } from "../../core/registry.js";
import { getSystem } from "../../core/prompts.js";
import { childLogger } from "../../infra/logger.js";
import { incrQuota } from "../../infra/redis.js";
import { env } from "../../core/config.js";

const log = childLogger({ module: "sales_pod" });

// ── Lead Intel Node ───────────────────────────────────────────────────────────

async function leadIntelNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  const tenantId = state.tenant_id;
  await checkBudget(tenantId);

  const company = getCompany("turicks");
  const companyContext = company
    ? JSON.stringify(company.profile, null, 2)
    : "Turicks AI Agency — LangGraph agentic systems";

  const systemPrompt = `You are a B2B sales intelligence analyst for Turicks AI Agency.
Research the prospect and return structured JSON.

Company Context:
${companyContext}

ICP: SME founders $50K–500K ARR who need AI automation.
Return ONLY valid JSON (no fences):
{
  "lead": {
    "name": "full name",
    "company": "company name",
    "url": "company URL or empty string",
    "pain_points": ["pain 1", "pain 2"],
    "icp_score": 0.0-1.0,
    "budget_signal": "high|medium|low|unknown",
    "linkedin_url": "URL or empty string",
    "source": "upwork|linkedin|referral|inbound|cold_email"
  },
  "intel_report": "2-3 paragraph research summary with specific findings"
}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`Research this prospect and build an intelligence profile:\n\n${state.task}`),
  ];

  let lead: LeadProfile | null = null;
  let intel_report: string | null = null;

  try {
    const result = await callCascade(
      "deep_research",
      messages,
      { agent: "lead_intel", tenant_id: tenantId },
    );

    const parsed = safeParseJson<{ lead: LeadProfile; intel_report: string }>(result.text);
    if (!parsed) throw new Error("safeParseJson returned null — no JSON in lead intel response");
    lead = parsed.lead;
    intel_report = parsed.intel_report;
    log.info({ company: lead.company, icp_score: lead.icp_score }, "Lead intel complete");
  } catch (err) {
    const isAggregate = err instanceof AggregateError;
    if (isAggregate) {
      log.error({ err: String(err), agent: "lead_intel" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "lead_intel", err: String(err) }],
      };
    }
    // JSON parse failure — degrade gracefully with defaults
    log.warn({ raw: String(err) }, "Lead intel parse failed — using defaults");
    intel_report = "Research unavailable — proceeding with minimal profile";
    lead = {
      name: "Unknown",
      company: "Unknown",
      url: "",
      pain_points: [],
      icp_score: 0.5,
      budget_signal: "unknown",
      source: "cold_email",
    };
  }

  return { lead, intel_report };
}

// ── Sales Engineer Node ───────────────────────────────────────────────────────

/**
 * Sales Engineer — strategic decision-maker for outreach angle.
 * Runs AFTER lead_intel, BEFORE bdr. Owns outreach strategy autonomously.
 * HITL guards only the final send — not this planning step.
 */
async function salesEngineerNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  const tenantId = state.tenant_id;
  await checkBudget(tenantId);

  const systemPrompt = getSystem("SALES_ENGINEER");

  const userContent = `LEAD PROFILE:
${JSON.stringify(state.lead, null, 2)}

INTEL REPORT:
${state.intel_report ?? "No intel available yet"}

Original task: ${state.task}

Choose the optimal outreach angle and return your strategy brief.`;

  const lcMessages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ];

  let sales_engineer_brief: SalesStateType["sales_engineer_brief"] = null;

  try {
    const result = await callCascade(
      "md",
      lcMessages,
      { agent: "sales_engineer", tenant_id: tenantId },
    );
    sales_engineer_brief = safeParseJson<NonNullable<SalesStateType["sales_engineer_brief"]>>(result.text);
    log.info({ angle: sales_engineer_brief?.angle }, "Sales engineer brief ready");
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "sales_engineer" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "sales_engineer", err: String(err) }],
      };
    }
    log.warn({ raw: String(err) }, "Sales engineer parse failed — proceeding without brief");
  }

  return { sales_engineer_brief };
}

// ── BDR Node ──────────────────────────────────────────────────────────────────

async function bdrNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  const tenantId = state.tenant_id;

  // Inject few-shot examples from past outcomes (self-improvement loop)
  const pastOutcomes = await getRecentOutcomes("bdr").catch(() => []);
  const fewShotBlock = pastOutcomes.length > 0
    ? "\n\nPAST EMAIL EXAMPLES (learn from these — real outcomes):\n" +
      pastOutcomes
        .map((o) => `[${o.outcome.toUpperCase()}] ${o.decision_summary ?? "no summary"}`)
        .join("\n")
    : "";

  // Build context from lead profile + any previous critique feedback
  const latestCritique = state.critiques.at(-1);
  const revisionContext = latestCritique
    ? `\n\nPREVIOUS CRITIQUE FEEDBACK (revision ${state.revision_count}):\n${latestCritique.notes}\nViolations: ${latestCritique.rule_violations.join(", ")}\n\nPlease fix these issues in your revision.`
    : "";

  const engineerContext = state.sales_engineer_brief
    ? `\nSALES ENGINEER STRATEGY:\n- Angle: ${state.sales_engineer_brief.angle}\n- Hook: ${state.sales_engineer_brief.hook}\n- Value prop: ${state.sales_engineer_brief.value_prop}\n- Proof point: ${state.sales_engineer_brief.proof_point}\n- CTA: ${state.sales_engineer_brief.cta}\n\nExecute this strategy exactly. Do not deviate from the angle chosen.`
    : "";

  const systemPrompt = `You are the BDR (Business Development Representative) for Turicks AI Agency.
Write a personalized outreach email based on the prospect research and sales engineer strategy.
${fewShotBlock}
RULES (non-negotiable):
- Pain-first opening: lead with their problem, not our capabilities
- Reference something specific about the prospect (post, product, company challenge)
- Word count: ≤ 150 words
- One clear CTA (no double CTAs)
- No links or attachments on first touch
- BANNED: "I wanted to reach out", "Hope this finds you well", "Just following up", "Quick question", "Touch base", "excited to share", "game-changer", "synergy"
${engineerContext}

Return ONLY valid JSON (no fences):
{"subject": "email subject line", "body": "email body text"}`;

  const userContent = `Intel Report:
${state.intel_report ?? "No intel available"}

Lead Profile:
${state.lead ? JSON.stringify(state.lead, null, 2) : "No lead profile"}

Original Task:
${state.task}${revisionContext}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ];

  let email_draft: { subject: string; body: string } | null = null;

  try {
    const result = await callCascade(
      "md",
      messages,
      { agent: "bdr", tenant_id: tenantId },
    );
    email_draft = safeParseJson<{ subject: string; body: string }>(result.text);
    if (!email_draft || !email_draft.subject || !email_draft.body) {
      email_draft = { subject: "Following up on your project", body: result.text };
    }
    log.info({ subject: email_draft.subject }, "BDR draft generated");
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "bdr" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "bdr", err: String(err) }],
      };
    }
    log.warn({ raw: String(err) }, "BDR parse failed — wrapping error");
    email_draft = { subject: "Following up on your project", body: "Draft unavailable — LLM error" };
  }

  return { email_draft };
}

// ── Critic Sales Wrapper ──────────────────────────────────────────────────────

async function criticSalesNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  return criticNode(state, "sales");
}

// ── HITL Node ─────────────────────────────────────────────────────────────────

async function hitlNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  const latestCritique = state.critiques.at(-1);
  const isEscalated =
    latestCritique?.result === "NEEDS_REVISION" &&
    state.revision_count >= state.max_revisions;

  const summary = isEscalated
    ? `⚠️ Escalated after ${state.revision_count} revisions. Critique: ${latestCritique?.notes}`
    : `Sales email draft ready for approval.\nLead: ${state.lead?.company ?? "Unknown"}`;

  const draft = state.email_draft
    ? `Subject: ${state.email_draft.subject}\n\n${state.email_draft.body}`
    : "(no draft)";

  const hitl = await requestHITL({
    thread_id: `${state.tenant_id}:sales:${state.trace_id}`,
    tenant_id: state.tenant_id,
    agent: "bdr",
    summary,
    draft,
    ttl_minutes: 120,
  });

  log.info({ interrupt_id: hitl.interrupt_id, escalated: isEscalated }, "HITL requested");

  return { hitl };
}

// ── Finalize Node ─────────────────────────────────────────────────────────────

async function finalizeNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  const idempotencyKey = `sales_draft_ready:${state.trace_id}`;

  // Idempotency guard — fail-open if DB unavailable
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
    action: "sales_draft_ready",
    idempotency_key: idempotencyKey,
    payload: {
      lead_company: state.lead?.company,
      email_subject: state.email_draft?.subject,
      revision_count: state.revision_count,
      hitl_interrupt_id: state.hitl?.interrupt_id,
    },
  }).catch((err) => {
    log.warn({ err: (err as NodeJS.ErrnoException).code ?? String(err) }, "writeAuditEntry failed — non-blocking");
  });

  const final = {
    lead: state.lead,
    email_draft: state.email_draft,
    revision_count: state.revision_count,
    hitl_status: state.hitl?.status ?? "pending",
    finalized_at: new Date().toISOString(),
  };

  const outcome = state.hitl?.status === "rejected" ? "hitl_rejected" : "succeeded";

  // Self-improvement: write task outcome for few-shot injection in future runs
  writeTaskOutcome({
    tenant_id: state.tenant_id,
    agent_id: "bdr",
    thread_id: `${state.tenant_id}:sales:${state.trace_id}`,
    lead_id: null,
    outcome,
    decision_summary: state.email_draft
      ? `Subject: ${state.email_draft.subject} | Lead: ${state.lead?.company ?? "unknown"}`
      : `Lead: ${state.lead?.company ?? "unknown"} — no draft`,
    tools_used: ["lead_intel", "sales_engineer_node", "bdr", "critic"],
    user_feedback: state.hitl?.rejection_reason ?? null,
    cost_usd: null,
    latency_ms: null,
  }).catch((err) => log.warn({ err: (err as Error).message }, "writeTaskOutcome failed — non-blocking"));

  // Phase 3C: publish cross-dept signal — marketing can use this for follow-up content (non-blocking)
  if (outcome === "succeeded" && state.email_draft) {
    publishDeptEvent({
      tenant_id: state.tenant_id,
      from_dept: "sales",
      to_dept: "marketing",
      event_type: "email_queued",
      payload: {
        company: state.lead?.company,
        email_subject: state.email_draft.subject,
        lead_url: state.lead?.url,
        icp_score: state.lead?.icp_score,
        thread_id: `${state.tenant_id}:sales:${state.trace_id}`,
      },
      thread_id: `${state.tenant_id}:sales:${state.trace_id}`,
    }).catch((err) => log.debug({ err: (err as Error).message }, "publishDeptEvent failed — non-blocking"));
  }

  log.info({ lead_company: state.lead?.company, outcome }, "Sales draft finalized");

  return { final };
}

// ── Safety Rails — Suppression + Quota (pure conditional edges) ──────────────

/**
 * Check if the lead's email/domain is on the suppression list.
 * Pure conditional edge — fail-open on error.
 */
async function suppressionCheckEdge(
  state: SalesStateType,
): Promise<"quota_check" | "suppressed_end"> {
  const email = state.lead?.linkedin_url ?? state.task;
  if (!email) return "quota_check";

  try {
    const suppressed = await isSuppressed(state.tenant_id, email);
    if (suppressed) {
      log.warn({ tenant_id: state.tenant_id, email: email.slice(0, 50) }, "Lead suppressed — skipping");
      return "suppressed_end";
    }
  } catch (err) {
    log.error({ err: (err as Error).message }, "Suppression check failed — fail-open");
  }
  return "quota_check";
}

/** Suppressed-end node — audit log + halt gracefully. */
async function suppressedEndNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  await writeAuditEntry({
    tenant_id: state.tenant_id,
    action: "sales_suppressed",
    idempotency_key: `sales_suppressed:${state.tenant_id}:${state.trace_id}`,
    payload: { lead_company: state.lead?.company, task: state.task.slice(0, 100) },
  });
  log.info({ lead_company: state.lead?.company }, "Sales flow halted — suppression");
  return { final: { status: "suppressed", lead: state.lead } };
}

/**
 * Quota gate node — reads Redis counter, records remaining capacity in state metadata.
 * Exists as a node (not a pure edge) so LangGraph can checkpoint it before routing.
 */
async function quotaCheckNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  // No state mutation — just a pass-through checkpoint. Routing handled by quotaCheckEdge.
  return {};
}

/**
 * Atomic daily send quota check via Redis INCR.
 * Pure conditional edge — increments counter, routes bdr or quota_end.
 * Fail-open: errors → continue to BDR.
 */
async function quotaCheckEdge(
  state: SalesStateType,
): Promise<"bdr" | "quota_end"> {
  try {
    const count = await incrQuota(state.tenant_id);
    if (count > env.DAILY_SEND_LIMIT) {
      log.warn({ tenant_id: state.tenant_id, count, limit: env.DAILY_SEND_LIMIT }, "Daily quota exceeded");
      return "quota_end";
    }
    log.info({ count, limit: env.DAILY_SEND_LIMIT }, "Quota check passed");
  } catch (err) {
    log.error({ err: (err as Error).message }, "Quota check failed — fail-open");
  }
  return "bdr";
}

/** Quota-end node — audit log + halt gracefully. */
async function quotaEndNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  await writeAuditEntry({
    tenant_id: state.tenant_id,
    action: "sales_quota_exceeded",
    idempotency_key: `sales_quota_exceeded:${state.tenant_id}:${state.trace_id}`,
    payload: { lead_company: state.lead?.company, daily_limit: env.DAILY_SEND_LIMIT },
  });
  log.info({ lead_company: state.lead?.company }, "Sales flow halted — daily quota exceeded");
  return { final: { status: "quota_exceeded", lead: state.lead } };
}

// ── Graph definition ──────────────────────────────────────────────────────────

const salesGraph = new StateGraph(SalesState)
  .addNode("lead_intel", leadIntelNode)
  .addNode("suppressed_end", suppressedEndNode)
  .addNode("quota_check", quotaCheckNode)
  .addNode("quota_end", quotaEndNode)
  .addNode("sales_engineer_node", salesEngineerNode)
  .addNode("bdr", bdrNode)
  .addNode("critic", criticSalesNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "lead_intel")
  .addConditionalEdges("lead_intel", suppressionCheckEdge, {
    quota_check: "quota_check",
    suppressed_end: "suppressed_end",
  })
  .addConditionalEdges("quota_check", quotaCheckEdge, {
    bdr: "sales_engineer_node",
    quota_end: "quota_end",
  })
  .addEdge("suppressed_end", END)
  .addEdge("quota_end", END)
  .addEdge("sales_engineer_node", "bdr")
  .addEdge("bdr", "critic")
  .addConditionalEdges("critic", afterCriticEdge, {
    generator: "bdr",
    hitl: "hitl_gate",
  })
  .addEdge("hitl_gate", "finalize")
  .addEdge("finalize", END);

export const salesSubgraph = salesGraph.compile();
