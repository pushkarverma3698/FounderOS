/**
 * FounderOS — CEO Supervisor Node
 * =================================
 * Classifies incoming tasks and routes to the correct department pod.
 *
 * Flow: receives FounderState → calls CEO cascade → emits routing update
 *
 * The CEO prompt returns JSON:
 *   { company, task, agent, direct_answer }
 *
 * supervisorNode resolves 'agent' → department via registry backlink,
 * with keyword fallback for agents that don't have explicit department.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { callCascade, checkBudget } from "../infra/llm.js";
import { getSystem } from "../core/prompts.js";
import { getAgent } from "../core/registry.js";
import type { FounderStateType } from "./state.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "supervisor" });

// Memoized CEO system prompt (auto-populated with company/agent list)
let _ceoPrompt: string | undefined;
function getCeoPrompt(): string {
  _ceoPrompt ??= getSystem("CEO");
  return _ceoPrompt;
}

// ── Department resolver ────────────────────────────────────────────────────────

/**
 * Resolve which department an agent name maps to.
 * Exported for unit testing.
 * Priority: registry `department` field → keyword heuristics.
 */
export function _resolveDepartment(
  agentName: string,
): "sales" | "engineering" | "marketing" | "social" | "prospecting" | null {
  // 1. Registry lookup (most reliable)
  const agent = getAgent(agentName);
  if (agent?.department) return agent.department;

  // 2. Keyword heuristics (for agents without explicit department)
  // NOTE: order matters — check more specific keywords first to avoid false matches.
  // e.g. "linkedin_outreach" → "outreach" is a sales keyword, check sales BEFORE social.
  const name = agentName.toLowerCase();

  // Prospecting is checked FIRST — /prospect commands and research tasks go here
  const prospectingKeywords = ["prospect", "disambiguate", "icp_scor", "icp_scorer", "lead_qualify", "lead_research"];
  if (prospectingKeywords.some((k) => name.includes(k))) return "prospecting";

  const salesKeywords = ["bdr", "lead_intel", "bidding", "proposal", "outreach", "pipeline_md", "sales"];
  if (salesKeywords.some((k) => name.includes(k))) return "sales";

  const engKeywords = ["dev", "coder", "qa", "tester", "github", "engineer", "vibe_cod"];
  if (engKeywords.some((k) => name.includes(k))) return "engineering";

  // Social is checked BEFORE marketing — social agents have dedicated platform keywords.
  // "social" prefix is included here so "social_media_bot" etc. route to social, not marketing.
  const socialKeywords = ["social_handler", "social_researcher", "platform_growth", "linkedin_growth", "linkedin_post", "instagram", "post_writer", "social_media", "social_"];
  if (socialKeywords.some((k) => name.includes(k))) return "social";

  const mktgKeywords = ["seo", "designer", "marketing", "content", "growth", "linkedin", "vibe_design"];
  if (mktgKeywords.some((k) => name.includes(k))) return "marketing";

  return null;
}

// ── Supervisor Node ────────────────────────────────────────────────────────────

interface CeoResponse {
  company: string;
  task: string;
  agent: string;
  direct_answer: string | null;
}

// Update FounderState department to include social
// (FounderState.department type is "sales"|"engineering"|"marketing"|"" — extended in graph routing)

export async function supervisorNode(
  state: FounderStateType,
): Promise<Partial<FounderStateType>> {
  const tenantId = state.tenant_id ?? "turicks";

  // Budget guard — CEO calls are expensive (Sonnet tier)
  await checkBudget(tenantId);

  // Phase 3C: log any pending cross-dept signals in state (durable signals are in dept_signals DB table)
  if (state.departmentSignals && state.departmentSignals.length > 0) {
    log.info(
      { signal_count: state.departmentSignals.length, signals: state.departmentSignals.map((s) => `${s.from}:${s.event}`) },
      "CEO: cross-department signals observed",
    );
  }

  log.info({ tenant_id: tenantId, task: state.task.slice(0, 80) }, "CEO classifying task");

  const messages: BaseMessage[] = [
    new SystemMessage(getCeoPrompt()),
    new HumanMessage(state.task),
  ];

  // Parse CEO JSON response
  let parsed: CeoResponse;
  try {
    const result = await callCascade("ceo", messages, {
      agent: "supervisor",
      tenant_id: tenantId,
    });
    // Strip any markdown fences the model may have added despite instructions
    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    try {
      parsed = JSON.parse(clean) as CeoResponse;
    } catch {
      log.warn({ raw: result.text }, "CEO returned non-JSON — falling back to direct_answer path");
      parsed = { company: tenantId, task: state.task, agent: "", direct_answer: result.text };
    }
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "supervisor" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "supervisor", err: String(err) }],
      };
    }
    log.warn({ raw: String(err) }, "Supervisor cascade failed — falling back to direct_answer");
    parsed = { company: tenantId, task: state.task, agent: "", direct_answer: null };
  }

  // Resolve department from agent name
  const department = _resolveDepartment(parsed.agent ?? "");

  log.info(
    { agent: parsed.agent, department, company: parsed.company },
    "CEO routing decision",
  );

  return {
    department: department ?? "",
    tenant_id: parsed.company || tenantId,
    task: parsed.task || state.task,
  };
}
