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
import type { CoreMessage } from "ai";
import { SalesState } from "../state.js";
import type { SalesStateType, LeadProfile } from "../state.js";
import { callCascade, checkBudget } from "../../infra/llm.js";
import { requestHITL } from "../../gateway/hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { criticNode, afterCriticEdge } from "../critic.js";
import { getCompany } from "../../core/registry.js";
import { childLogger } from "../../infra/logger.js";

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

  const messages: CoreMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: `Research this prospect and build an intelligence profile:\n\n${state.task}` },
  ];

  const result = await callCascade(
    "deep_research",
    messages,
    { agent: "lead_intel", tenant_id: tenantId },
  );

  let lead: LeadProfile | null = null;
  let intel_report: string | null = null;

  try {
    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as { lead: LeadProfile; intel_report: string };
    lead = parsed.lead;
    intel_report = parsed.intel_report;
    log.info({ company: lead.company, icp_score: lead.icp_score }, "Lead intel complete");
  } catch {
    log.warn({ raw: result.text.slice(0, 200) }, "Lead intel parse failed — using raw report");
    intel_report = result.text;
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

// ── BDR Node ──────────────────────────────────────────────────────────────────

async function bdrNode(state: SalesStateType): Promise<Partial<SalesStateType>> {
  const tenantId = state.tenant_id;

  // Build context from lead profile + any previous critique feedback
  const latestCritique = state.critiques.at(-1);
  const revisionContext = latestCritique
    ? `\n\nPREVIOUS CRITIQUE FEEDBACK (revision ${state.revision_count}):\n${latestCritique.notes}\nViolations: ${latestCritique.rule_violations.join(", ")}\n\nPlease fix these issues in your revision.`
    : "";

  const systemPrompt = `You are the BDR (Business Development Representative) for Turicks AI Agency.
Write a personalized outreach email based on the prospect research.

RULES (non-negotiable):
- Pain-first opening: lead with their problem, not our capabilities
- Reference something specific about the prospect (post, product, company challenge)
- Word count: ≤ 150 words
- One clear CTA (no double CTAs)
- No links or attachments on first touch
- BANNED: "I wanted to reach out", "Hope this finds you well", "Just following up", "Quick question", "Touch base", "excited to share", "game-changer", "synergy"

Return ONLY valid JSON (no fences):
{"subject": "email subject line", "body": "email body text"}`;

  const userContent = `Intel Report:
${state.intel_report ?? "No intel available"}

Lead Profile:
${state.lead ? JSON.stringify(state.lead, null, 2) : "No lead profile"}

Original Task:
${state.task}${revisionContext}`;

  const messages: CoreMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userContent },
  ];

  const result = await callCascade(
    "md",
    messages,
    { agent: "bdr", tenant_id: tenantId },
  );

  let email_draft: { subject: string; body: string } | null = null;

  try {
    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    email_draft = JSON.parse(clean) as { subject: string; body: string };
    log.info({ subject: email_draft.subject }, "BDR draft generated");
  } catch {
    log.warn({ raw: result.text.slice(0, 200) }, "BDR parse failed — wrapping raw text");
    email_draft = {
      subject: "Following up on your project",
      body: result.text,
    };
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

  // Idempotency guard
  if (await hasBeenAudited(idempotencyKey)) {
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
  });

  const final = {
    lead: state.lead,
    email_draft: state.email_draft,
    revision_count: state.revision_count,
    hitl_status: state.hitl?.status ?? "pending",
    finalized_at: new Date().toISOString(),
  };

  log.info({ lead_company: state.lead?.company }, "Sales draft finalized");

  return { final };
}

// ── Graph definition ──────────────────────────────────────────────────────────

const salesGraph = new StateGraph(SalesState)
  .addNode("lead_intel", leadIntelNode)
  .addNode("bdr", bdrNode)
  .addNode("critic", criticSalesNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "lead_intel")
  .addEdge("lead_intel", "bdr")
  .addEdge("bdr", "critic")
  .addConditionalEdges("critic", afterCriticEdge, {
    generator: "bdr",
    hitl: "hitl_gate",
  })
  .addEdge("hitl_gate", "finalize")
  .addEdge("finalize", END);

export const salesSubgraph = salesGraph.compile();
