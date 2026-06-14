/**
 * FounderOS — Revenue domain (Phase 5 hierarchy spike)
 * ====================================================
 * A PROOF that the prebuilt supervisor nests: a `revenue` sub-supervisor over
 * {marketing, sales} can itself be an agent under the parent supervisor, and an
 * HITL `interrupt()` raised THREE levels deep (parent → revenue → sales →
 * send_email) still surfaces and resumes correctly through the same
 * getState().tasks path the gateway run-loop uses.
 *
 * ⚠️ NOT wired into the live office (office.ts stays FLAT, 7 departments). This
 * is the capability proof; promoting nesting into production is trigger-gated
 * (≥2 coordinating agents in a domain) AND gated on live MTProto verification of
 * nested interrupt/resume/wedge — see ADR-025 and the plan's Phase 5 gate. The
 * flat pre-router bypass and the fragile office-run.ts loop are untouched.
 *
 * Depth is capped at 2 (parent → revenue → dept). We do not nest further.
 */

import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel } from "./model.js";
import { createTrimmedPrompt } from "../infra/context-manager.js";
import { DEPARTMENT_TOOLS } from "./capabilities.js";
import { MARKETING_PROMPT, SALES_PROMPT, RESEARCH_PROMPT } from "./system-prompts.js";

const subAgentBudget = { maxTokens: 4000 };

const REVENUE_PROMPT = `You are the Revenue domain supervisor for Turicks. You coordinate two departments:
- marketing → LinkedIn content in the Turicks brand voice (linkedin_post pauses for founder approval).
- sales → prospect research + cold outreach emails (send_email pauses for founder approval).

Route each request to exactly one department. Relay that department's result verbatim — do not summarise or add preamble. For "post on LinkedIn" → marketing. For "email"/"cold outreach"/"reach out to" → sales.`;

const NESTED_PARENT_PROMPT = `You are the Chief of Staff for Turicks. Route each request to one team:
- research → questions, facts, company/market info (search the web).
- revenue → anything about LinkedIn posts, marketing content, cold outreach, or sending emails to prospects.

Route to exactly one team and relay its result verbatim. No preamble.`;

/**
 * Build the nested `revenue` sub-supervisor (over marketing + sales), compiled
 * as a sub-graph WITHOUT its own checkpointer — the parent supplies persistence.
 */
export function buildRevenueDomain() {
  const llm = getModel();
  const marketing = createReactAgent({
    llm,
    tools: DEPARTMENT_TOOLS["marketing"]!,
    name: "marketing",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(MARKETING_PROMPT, subAgentBudget) as any,
  });
  const sales = createReactAgent({
    llm,
    tools: DEPARTMENT_TOOLS["sales"]!,
    name: "sales",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(SALES_PROMPT, subAgentBudget) as any,
  });
  return createSupervisor({
    agents: [marketing, sales],
    llm,
    prompt: REVENUE_PROMPT,
    outputMode: "last_message",
    includeAgentName: "inline",
    supervisorName: "revenue",
  }).compile({ name: "revenue" });
}

/**
 * Build a PARENT supervisor over [research, revenue(sub-supervisor)] — the
 * 2-level hierarchy proof. Compiled with the given checkpointer (HITL crash-safe
 * exactly like the flat office). Exported for the integration test; not used in
 * production.
 */
export function buildNestedOffice(checkpointer: BaseCheckpointSaver) {
  const llm = getModel();
  const revenue = buildRevenueDomain();
  const research = createReactAgent({
    llm,
    tools: DEPARTMENT_TOOLS["research"]!,
    name: "research",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(RESEARCH_PROMPT, subAgentBudget) as any,
  });
  return createSupervisor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents: [research, revenue as any],
    llm,
    prompt: NESTED_PARENT_PROMPT,
    outputMode: "last_message",
    includeAgentName: "inline",
  }).compile({ checkpointer });
}
