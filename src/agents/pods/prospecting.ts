/**
 * FounderOS — ProspectingPod Subgraph
 * =====================================
 * Qualifies inbound leads BEFORE they enter the SalesPod.
 * Triggered by Telegram /prospect <url|company name> command.
 *
 * Flow:
 *   disambiguate_node → research_node → icp_score_node → route_by_score (edge)
 *
 * Note on node naming: LangGraph prohibits node names that match state attribute names.
 *   "research_node"  — avoids clash with ProspectingState.research
 *   "icp_score_node" — avoids clash with ProspectingState.icp_score
 *        └─ NANO tier       └─ NANO tier    └─ MD tier         └─ pure function
 *
 * Routing outcomes:
 *   outreach_tier = null ("disqualified") → disqualify_node → END
 *   outreach_tier = "md"                  → handoff_node → END
 *   outreach_tier = "ceo"                 → handoff_node → END
 *
 * The main FounderGraph reads outreach_tier from the subgraph result
 * to decide whether to invoke SalesPod (Phase 2B: wired in graph.ts).
 *
 * Design decisions:
 * - Redis-first for research: research:{md5(url)} TTL 7 days
 *   prevents re-scraping the same company repeatedly
 * - NANO tier for research extraction (cost ~$0.001/company)
 * - MD tier for ICP scoring (higher reasoning quality for the go/no-go decision)
 * - route_by_score is a pure function — NO LLM — so it's cheap, fast, and testable
 * - lead_pipeline row created on first disambiguation (dedup check included)
 *
 * See plan §Phase 2B for full specification.
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createHash } from "crypto";
import { ProspectingState } from "../state.js";
import type { ProspectingStateType, CompanyResearch } from "../state.js";
import { callCascade, checkBudget, runToolExecutor, safeParseJson } from "../../infra/llm.js";
import { cacheGet, cacheSet, KEYS } from "../../infra/redis.js";
import {
  createLead,
  updateLeadStage,
  getLeadByUrl,
  writeTaskOutcome,
  getRecentOutcomes,
  publishDeptEvent,
} from "../../db/queries.js";
// NOTE: webSearchTool is no longer imported directly — researchNode uses
// runToolExecutor (Phase 3A two-phase pattern) to let local Qwen refine the query.
import { getSystem } from "../../core/prompts.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "prospecting_pod" });

/** TTL for the research cache: 7 days in seconds */
const RESEARCH_TTL_SECONDS = 7 * 24 * 60 * 60;

// ── Node: Disambiguate ────────────────────────────────────────────────────────

/**
 * NANO tier — canonicalise a raw URL or company name.
 * Creates a lead_pipeline row (or re-uses existing one to avoid duplication).
 * Output: company_url, company_name, lead_id
 */
async function disambiguateNode(
  state: ProspectingStateType,
): Promise<Partial<ProspectingStateType>> {
  const tenantId = state.tenant_id;
  await checkBudget(tenantId);

  log.info({ raw_input: state.raw_input }, "Disambiguating company input");

  const systemPrompt = getSystem("DISAMBIGUATE");
  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`Extract the canonical company URL and name from this input:\n\n${state.raw_input}`),
  ];

  let company_url: string | null = null;
  let company_name: string | null = null;

  try {
    const result = await callCascade(
      "nano",
      messages,
      { agent: "disambiguate", tenant_id: tenantId },
    );

    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as { company_url: string; company_name: string };
    company_url = parsed.company_url ?? null;
    company_name = parsed.company_name ?? null;
    log.info({ company_url, company_name }, "Disambiguation complete");
  } catch (err) {
    // Fallback: treat raw_input as URL directly
    const raw = state.raw_input.trim();
    company_url = raw.startsWith("http") ? raw : `https://${raw}`;
    company_name = raw;
    log.warn({ err: (err as Error).message }, "Disambiguation failed — using raw input as URL");
  }

  if (!company_url) {
    return {
      errors: [{ node: "disambiguate", error: "Could not determine company URL" }],
    };
  }

  // ── Deduplication: check if this URL is already in our pipeline ──────────
  let existing: Awaited<ReturnType<typeof getLeadByUrl>> = null;
  try {
    existing = await getLeadByUrl(tenantId, company_url);
  } catch (dbErr) {
    const code = (dbErr as NodeJS.ErrnoException).code ?? "UNKNOWN";
    log.warn({ code, company_url }, "DB unavailable for dedup check — treating as new lead");
  }
  let lead_id = existing?.id ?? null;

  if (existing) {
    log.info({ lead_id, stage: existing.stage }, "Lead already exists in pipeline — reusing");
  } else {
    // Create new lead pipeline row at stage 'researching'
    try {
      lead_id = await createLead({
        tenant_id: tenantId,
        company_url,
        company_name,
        stage: "researching",
      });
      log.info({ lead_id, company_url }, "Lead pipeline row created");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
        // DB unavailable — continue without a lead_id; pipeline still runs
        log.warn({ code, company_url }, "DB unavailable for lead creation — continuing without lead_id");
      } else {
        log.error({ err: (err as Error).message, company_url }, "Failed to create lead");
        return {
          company_url,
          company_name,
          errors: [{ node: "disambiguate", error: (err as Error).message }],
        };
      }
    }
  }

  return { company_url, company_name, lead_id };
}

// ── Node: Research ────────────────────────────────────────────────────────────

/**
 * NANO tier, Redis-first.
 * 1. Check Redis research:{md5(url)} → return cached blob if hit
 * 2. If miss: web search + LLM extraction → store in Redis (TTL 7d)
 * 3. Output: CompanyResearch blob in state.research
 */
async function researchNode(
  state: ProspectingStateType,
): Promise<Partial<ProspectingStateType>> {
  const tenantId = state.tenant_id;
  const url = state.company_url;

  if (!url) {
    log.warn("Research skipped — no company_url in state");
    return { errors: [{ node: "research", error: "No company_url to research" }] };
  }

  await checkBudget(tenantId);

  // ── Redis cache check ─────────────────────────────────────────────────────
  const urlHash = createHash("md5").update(url.toLowerCase().trim()).digest("hex");
  const cacheKey = KEYS.research(url);

  const cached = await cacheGet<CompanyResearch>(cacheKey);
  if (cached) {
    log.info({ url, cache_key: cacheKey }, "Research cache hit — skipping scrape");
    return { research: { ...cached, cached: true } };
  }

  log.info({ url }, "Research cache miss — scraping");

  // ── Web search via runToolExecutor (Phase 3A two-phase pattern) ─────────
  // Local Qwen refines/validates the search query before execution.
  // Falls back to the original argsHint if local LLM is unavailable.
  let searchContext = "";
  try {
    const execResult = await runToolExecutor(
      "search_web",
      {
        query: `${state.company_name ?? url} company overview pain points technology stack funding team size`,
        limit: 5,
      },
      {
        agent: "prospecting_researcher",
        tenant_id: tenantId,
        context: `Researching ${url} for ICP scoring. Company: ${state.company_name ?? "(unknown)"}`,
      },
    );

    if (execResult.toolResult.success && execResult.toolResult.data) {
      searchContext = JSON.stringify(execResult.toolResult.data).slice(0, 3000);
      log.debug({ model: execResult.model, url }, "Web search via runToolExecutor succeeded");
    } else {
      log.debug("Web search returned no results — relying on LLM knowledge");
      searchContext = `URL: ${url}\nCompany name: ${state.company_name ?? "(unknown)"}`;
    }
  } catch (searchErr) {
    log.debug({ err: (searchErr as Error).message }, "Web search not available — relying on LLM knowledge");
    searchContext = `URL: ${url}\nCompany name: ${state.company_name ?? "(unknown)"}`;
  }

  // ── LLM extraction ────────────────────────────────────────────────────────
  const systemPrompt = getSystem("PROSPECTING_RESEARCHER");
  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Research this company and extract key intelligence.\n\nCompany: ${state.company_name ?? url}\nURL: ${url}\n\nSearch context:\n${searchContext}`,
    ),
  ];

  let research: CompanyResearch;

  try {
    const result = await callCascade(
      "nano",
      messages,
      { agent: "prospecting_researcher", tenant_id: tenantId },
    );

    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as Omit<CompanyResearch, "cached">;

    research = {
      pain_points: Array.isArray(parsed.pain_points) ? parsed.pain_points : [],
      tech_stack: Array.isArray(parsed.tech_stack) ? parsed.tech_stack : [],
      team_size: parsed.team_size ?? "unknown",
      funding: parsed.funding ?? "unknown",
      recent_news: Array.isArray(parsed.recent_news) ? parsed.recent_news : [],
      raw_summary: parsed.raw_summary ?? "",
      cached: false,
    };

    log.info(
      { url, pain_points: research.pain_points.length },
      "Research extraction complete",
    );
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "prospecting_researcher" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "prospecting_researcher", err: String(err) }],
      };
    }
    log.warn({ err: (err as Error).message, url }, "Research LLM failed — using minimal stub");
    research = {
      pain_points: [],
      tech_stack: [],
      team_size: "unknown",
      funding: "unknown",
      recent_news: [],
      raw_summary: `Could not extract research for ${url}: ${(err as Error).message}`,
      cached: false,
    };
  }

  // ── Store in Redis (TTL 7 days) ───────────────────────────────────────────
  void cacheSet(cacheKey, research, RESEARCH_TTL_SECONDS);
  void urlHash; // used above to create cacheKey, linting safety

  return { research };
}

// ── Node: ICP Score ───────────────────────────────────────────────────────────

/**
 * MD tier — score the lead against Turicks' ICP.
 * Updates lead_pipeline with icp_score, icp_rationale, outreach_tier.
 * Sets stage to 'disqualified' (score < 0.4) or 'drafting' (score >= 0.4).
 */
async function icpScoreNode(
  state: ProspectingStateType,
): Promise<Partial<ProspectingStateType>> {
  const tenantId = state.tenant_id;
  const research = state.research;

  if (!research) {
    log.warn("ICP scoring skipped — no research in state");
    return { errors: [{ node: "icp_score", error: "No research data available" }] };
  }

  await checkBudget(tenantId);

  // Inject few-shot examples from past outcomes (self-improvement loop)
  const pastOutcomes = await getRecentOutcomes("icp_scorer").catch(() => []);
  const fewShotBlock = pastOutcomes.length > 0
    ? "\n\nPAST ICP SCORING EXAMPLES (learn from these — real outcomes):\n" +
      pastOutcomes
        .map((o) => `[${o.outcome.toUpperCase()}] ${o.decision_summary ?? "no summary"}`)
        .join("\n")
    : "";

  const basePrompt = getSystem("ICP_SCORER");
  const systemPrompt = basePrompt + fewShotBlock;
  const researchSummary = `Company: ${state.company_name ?? state.company_url ?? "unknown"}
URL: ${state.company_url ?? "unknown"}

Pain points: ${research.pain_points.join(", ") || "none identified"}
Tech stack: ${research.tech_stack.join(", ") || "unknown"}
Team size: ${research.team_size}
Funding: ${research.funding}
Recent news: ${research.recent_news.join("; ") || "none"}

Raw summary:
${research.raw_summary}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`Score this company against our ICP:\n\n${researchSummary}`),
  ];

  let icp_score: number | null = null;
  let icp_rationale: string | null = null;
  let outreach_tier: "md" | "ceo" | null = null;

  try {
    const result = await callCascade(
      "md",
      messages,
      { agent: "icp_scorer", tenant_id: tenantId },
    );

    const parsed = safeParseJson<{
      icp_score: number;
      icp_rationale: string;
      outreach_tier: "md" | "ceo" | "disqualified";
    }>(result.text);
    if (!parsed) throw new Error("safeParseJson returned null — no valid JSON in ICP scoring response");

    icp_score = Math.min(1.0, Math.max(0.0, Number(parsed.icp_score) || 0));
    icp_rationale = parsed.icp_rationale ?? "";

    // Ensure tier matches score bands (belt-and-suspenders vs LLM output)
    if (icp_score < 0.4) {
      outreach_tier = null; // disqualified
    } else if (icp_score < 0.7) {
      outreach_tier = "md";
    } else {
      outreach_tier = "ceo";
    }

    log.info(
      { icp_score, outreach_tier, company: state.company_name },
      "ICP scoring complete",
    );
  } catch (err) {
    if (err instanceof AggregateError) {
      log.error({ err: String(err), agent: "icp_scorer" }, "All LLM providers failed — returning error state");
      return {
        ...state,
        errors: [...(state.errors ?? []), { agent: "icp_scorer", err: String(err) }],
      };
    }
    log.warn({ err: (err as Error).message }, "ICP scoring failed — defaulting to disqualified");
    icp_score = 0;
    icp_rationale = `Scoring failed: ${(err as Error).message}`;
    outreach_tier = null;
  }

  // ── Persist to lead_pipeline ──────────────────────────────────────────────
  if (state.lead_id) {
    const stage = outreach_tier ? "drafting" : "disqualified";
    try {
      await updateLeadStage(state.lead_id, stage, {
        icp_score: String(icp_score),
        icp_rationale,
        outreach_tier,
      });
      log.info({ lead_id: state.lead_id, stage }, "Lead stage updated");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Failed to update lead stage");
    }
  }

  return { icp_score, icp_rationale, outreach_tier };
}

// ── Node: Disqualify ──────────────────────────────────────────────────────────

/**
 * Terminal node for disqualified leads (icp_score < 0.4).
 * Logs the disqualification — the Telegram daily digest picks these up.
 * Phase 1C: actual Telegram notification wired when gateway is ready.
 */
async function disqualifyNode(
  state: ProspectingStateType,
): Promise<Partial<ProspectingStateType>> {
  log.info(
    {
      company: state.company_name ?? state.company_url,
      icp_score: state.icp_score,
      rationale: state.icp_rationale,
    },
    "Lead disqualified — below ICP threshold",
  );

  // TODO Phase 1C: send to Telegram daily digest
  // await sendTelegramDisqualifiedDigest(state);

  // Self-improvement: write task outcome for few-shot injection in future runs
  writeTaskOutcome({
    tenant_id: state.tenant_id,
    agent_id: "icp_scorer",
    thread_id: `${state.tenant_id}:prospecting:${state.trace_id}`,
    lead_id: state.lead_id ?? null,
    outcome: "succeeded",
    decision_summary: `DISQUALIFIED | ${state.company_name ?? state.company_url ?? "unknown"} | score=${state.icp_score?.toFixed(2) ?? "0"} | ${state.icp_rationale?.slice(0, 120) ?? "below threshold"}`,
    tools_used: ["disambiguate", "research_node", "icp_score_node"],
    user_feedback: null,
    cost_usd: null,
    latency_ms: null,
  }).catch((err) => log.warn({ err: (err as Error).message }, "writeTaskOutcome failed — non-blocking"));

  // Phase 3C: publish cross-dept signal (non-blocking — signal is advisory, not critical path)
  publishDeptEvent({
    tenant_id: state.tenant_id,
    from_dept: "prospecting",
    to_dept: null,  // broadcast — supervisor can observe
    event_type: "lead_disqualified",
    payload: {
      company: state.company_name ?? state.company_url,
      icp_score: state.icp_score,
      rationale: state.icp_rationale?.slice(0, 200),
      lead_id: state.lead_id,
    },
    thread_id: `${state.tenant_id}:prospecting:${state.trace_id}`,
  }).catch((err) => log.debug({ err: (err as Error).message }, "publishDeptEvent failed — non-blocking"));

  return {};
}

// ── Node: Handoff ─────────────────────────────────────────────────────────────

/**
 * Terminal node for qualified leads.
 * Marks the lead as ready for SalesPod outreach.
 * The main FounderGraph wrapper reads outreach_tier from the subgraph result
 * and routes to the SalesPod with the correct tier.
 */
async function handoffNode(
  state: ProspectingStateType,
): Promise<Partial<ProspectingStateType>> {
  log.info(
    {
      company: state.company_name ?? state.company_url,
      icp_score: state.icp_score,
      outreach_tier: state.outreach_tier,
      lead_id: state.lead_id,
    },
    "Lead qualified — handing off to SalesPod",
  );

  // Self-improvement: write task outcome for few-shot injection in future runs
  writeTaskOutcome({
    tenant_id: state.tenant_id,
    agent_id: "icp_scorer",
    thread_id: `${state.tenant_id}:prospecting:${state.trace_id}`,
    lead_id: state.lead_id ?? null,
    outcome: "succeeded",
    decision_summary: `QUALIFIED | ${state.company_name ?? state.company_url ?? "unknown"} | tier=${state.outreach_tier ?? "unknown"} | score=${state.icp_score?.toFixed(2) ?? "0"} | ${state.icp_rationale?.slice(0, 120) ?? "qualified"}`,
    tools_used: ["disambiguate", "research_node", "icp_score_node"],
    user_feedback: null,
    cost_usd: null,
    latency_ms: null,
  }).catch((err) => log.warn({ err: (err as Error).message }, "writeTaskOutcome failed — non-blocking"));

  // Phase 3C: publish cross-dept signal to SalesPod (non-blocking)
  publishDeptEvent({
    tenant_id: state.tenant_id,
    from_dept: "prospecting",
    to_dept: "sales",
    event_type: "lead_qualified",
    payload: {
      company: state.company_name ?? state.company_url,
      company_url: state.company_url,
      icp_score: state.icp_score,
      outreach_tier: state.outreach_tier,
      lead_id: state.lead_id,
      rationale: state.icp_rationale?.slice(0, 200),
    },
    thread_id: `${state.tenant_id}:prospecting:${state.trace_id}`,
  }).catch((err) => log.debug({ err: (err as Error).message }, "publishDeptEvent failed — non-blocking"));

  return {};
}

// ── Conditional Edge: route_by_score ─────────────────────────────────────────

/**
 * Pure function — no LLM, no DB, no side effects.
 * Decides next node based solely on outreach_tier.
 *
 * Bands:
 *   icp_score < 0.4   → outreach_tier = null  → "disqualify"
 *   icp_score 0.4–0.69 → outreach_tier = "md"  → "handoff"
 *   icp_score >= 0.7   → outreach_tier = "ceo" → "handoff"
 */
function routeByScore(
  state: ProspectingStateType,
): "disqualify" | "handoff" {
  if (!state.outreach_tier) return "disqualify";
  return "handoff";
}

// ── Subgraph Compilation ──────────────────────────────────────────────────────

const prospectingGraphBuilder = new StateGraph(ProspectingState)
  .addNode("disambiguate", disambiguateNode)
  .addNode("research_node", researchNode)   // named "research_node" to avoid clash with ProspectingState.research attribute
  .addNode("icp_score_node", icpScoreNode)  // named "icp_score_node" to avoid clash with ProspectingState.icp_score attribute
  .addNode("disqualify", disqualifyNode)
  .addNode("handoff", handoffNode)

  .addEdge(START, "disambiguate")
  .addEdge("disambiguate", "research_node")
  .addEdge("research_node", "icp_score_node")

  .addConditionalEdges("icp_score_node", routeByScore, {
    disqualify: "disqualify",
    handoff: "handoff",
  })

  .addEdge("disqualify", END)
  .addEdge("handoff", END);

/**
 * Compiled prospecting subgraph.
 * Invoked by the main FounderGraph prospecting wrapper node (wired in graph.ts Phase 2B).
 * Can also be invoked standalone for testing:
 *   await prospectingSubgraph.invoke({ raw_input: "https://acme.com", tenant_id: "turicks" })
 */
export const prospectingSubgraph = prospectingGraphBuilder.compile();

export type ProspectingResult = typeof ProspectingState.State;
