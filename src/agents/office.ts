/**
 * FounderOS v2 — The Office (Supervisor + Department Sub-Agents)
 * ==============================================================
 * The whole multi-agent system in one file. A prebuilt LangGraph supervisor
 * routes each request to one of three department sub-agents, each a ReAct agent
 * with real, HITL-gated tools.
 *
 *   supervisor (Chief of Staff)
 *     ├─ research      → [search_web]
 *     ├─ comms         → [send_email*, linkedin_post*]
 *     └─ engineering   → [github_read, github_write*]
 *                          (* = requires founder approval via interrupt())
 *
 * Compiled ONCE with the Postgres checkpointer (rule: never compile per request).
 * The checkpointer also makes HITL crash-safe for free — a pending approval
 * survives a process restart because the graph state is persisted.
 */

import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import type { CompiledStateGraph, BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel, getModelFallbackMiddleware } from "./model.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { createAgentMiddleware, createTrimmedPrompt, type TrimOptions } from "../infra/context-manager.js";
import { DEPARTMENT_TOOLS, applyMcpBridge } from "./capabilities.js";
import { ENGINEERING_SUBGRAPH_ENABLED, REVENUE_SUBGRAPH_ENABLED } from "../core/config.js";
import { buildEngineeringDomain } from "./engineering-domain.js";
import { buildRevenueDomain } from "./revenue-domain.js";
import { assertContextIsolation, CONTEXT_ISOLATION_OUTPUT_MODE } from "./context-isolation.js";
import {
  buildSupervisorPrompt,
  ADMIN_PROMPT,
  RESEARCH_PROMPT,
  buildCommsPrompt,
  ENGINEERING_PROMPT,
  MARKETING_PROMPT,
  SALES_PROMPT,
  PERSONAL_PROMPT,
  JOBHUNT_PROMPT,
  SCHEDULER_BRIEF_PROMPT,
} from "./system-prompts.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ApprovalRequest } from "./agent-tools.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "office" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _office: CompiledStateGraph<any, any, any> | undefined;

const DEPARTMENT_DESCRIPTIONS = {
  admin: "Use for business context, episodic memory, recording decisions, and viewing pending cross-department signals.",
  research: "Use for web facts, news, company or market research, ICP scoring, and internal Turicks knowledge lookups.",
  comms: "Use for reading inbox, known-contact email, and Google Calendar work.",
  engineering: "Use for GitHub repositories, issues, pull requests, code, tests, deployments, and FounderOS engineering work.",
  marketing: "Use for LinkedIn posts, content strategy, reading LinkedIn comments, drafting comment replies and connection notes (copy-paste, no auto-send), and Turicks brand copy.",
  sales: "Use for prospect research tied to cold outreach, unknown-company outreach, and sales emails.",
  revenue: "Use for LinkedIn marketing content and sales cold outreach (routes internally to marketing or sales).",
  personal: "Use for files, directories, shell, browser, and laptop operations on the founder's machine.",
  jobhunt: "Use for job searches, CV/resume work, applications, and hiring-manager outreach.",
} as const;

/** Deterministic search caps — prompt instructions alone are not enough on OpenRouter. */
const SEARCH_TOOL_LIMITS = {
  search_web: 2,
  search_knowledge: 2,
  search_turicks_brain: 2,
  search_research_cache: 2,
  scrape_url: 2,
  deep_research: 1,
  crawl_site: 1,
} as const;

/**
 * Build (compile) the office graph with a given checkpointer.
 * Exported for tests (inject MemorySaver). Production uses getOffice().
 */
export function buildOffice(checkpointer: BaseCheckpointSaver) {
  // createSupervisor requires a model with bindTools — withFallbacks() wrappers break routing.
  const llm = getModel();
  const deptModel = getModel();

  // ── Phase C tools (available across departments) ──────────────────────────
  // search_knowledge: turicks-brain keyword search (no LLM cost)
  // read_context / update_context: supervisor-only business state

  // Token budgets (trimming happens before each LLM call, not in the checkpointer):
  //   Sub-agents: 4000 tokens — tool-focused, short working memory is enough
  //   Supervisor: 6000 tokens — needs routing context across more turns
  const subAgentBudget = { maxTokens: 4000 };
  const supervisorBudget = { maxTokens: 6000 };
  const agentMiddleware = (
    prompt: string | (() => string),
    toolCallLimitsOrOpts?: Record<string, number> | TrimOptions,
  ) => {
    const extra: TrimOptions =
      toolCallLimitsOrOpts !== undefined &&
      ("stopToolsAfterFailure" in toolCallLimitsOrOpts ||
        "maxTokens" in toolCallLimitsOrOpts ||
        "toolCallLimits" in toolCallLimitsOrOpts)
        ? (toolCallLimitsOrOpts as TrimOptions)
        : { toolCallLimits: toolCallLimitsOrOpts as Record<string, number> | undefined };
    return [
      ...getModelFallbackMiddleware(),
      ...createAgentMiddleware(prompt, {
        ...subAgentBudget,
        ...extra,
      }),
    ];
  };
  // ── Admin worker (ADR-028): context + memory + signal visibility ─────────
  const admin = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["admin"]!,
    name: "admin",
    description: DEPARTMENT_DESCRIPTIONS.admin,
    includeAgentName: "inline",
    middleware: agentMiddleware(ADMIN_PROMPT),
  }).graph;

  // research: web search + internal knowledge + ICP scoring (no read_emails — inbox stays in comms)
  const research = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["research"]!,
    name: "research",
    description: DEPARTMENT_DESCRIPTIONS.research,
    includeAgentName: "inline",
    middleware: agentMiddleware(RESEARCH_PROMPT, SEARCH_TOOL_LIMITS),
  }).graph;

  // comms: Gmail + Calendar only (linkedin_post moved to marketing — single owner)
  const comms = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["comms"]!,
    name: "comms",
    description: DEPARTMENT_DESCRIPTIONS.comms,
    includeAgentName: "inline",
    middleware: agentMiddleware(buildCommsPrompt),
  }).graph;

  // engineering: either the flat ReAct agent (production default) or the
  // hierarchical CTO sub-supervisor (coder/qa/devops) when ENGINEERING_SUBGRAPH=1.
  // BOTH are named "engineering", so the supervisor's routing + capability
  // manifest are identical — only the internal topology of the node changes.
  // The subgraph is compiled WITHOUT its own checkpointer (engineering-domain.ts);
  // the parent's checkpointer here supplies persistence so nested interrupts are
  // crash-safe (hierarchy plan P2 / ADR-027).
  const engineering = ENGINEERING_SUBGRAPH_ENABLED
    ? buildEngineeringDomain()
    : createAgent({
        model: deptModel,
        tools: DEPARTMENT_TOOLS["engineering"]!,
        name: "engineering",
        description: DEPARTMENT_DESCRIPTIONS.engineering,
        includeAgentName: "inline",
        middleware: agentMiddleware(ENGINEERING_PROMPT, {
          stopToolsAfterFailure: true,
          toolCallLimits: { claude_code: 1, github_write: 1 },
        }),
      }).graph;

  // ── Phase B departments ───────────────────────────────────────────────────

  /** Marketing: LinkedIn content in Turicks brand voice. */
  const marketing = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["marketing"]!,
    name: "marketing",
    description: DEPARTMENT_DESCRIPTIONS.marketing,
    includeAgentName: "inline",
    middleware: agentMiddleware(MARKETING_PROMPT, { search_web: SEARCH_TOOL_LIMITS.search_web }),
  }).graph;

  /** Sales: researches prospects + writes cold outreach emails (HITL-gated). */
  const sales = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["sales"]!,
    name: "sales",
    description: DEPARTMENT_DESCRIPTIONS.sales,
    includeAgentName: "inline",
    middleware: agentMiddleware(SALES_PROMPT, { search_web: SEARCH_TOOL_LIMITS.search_web }),
  }).graph;

  /** Personal: senior engineer on the founder's laptop — files, shell, browser
   *  (write/shell/browser HITL-gated; reads are instant). */
  const personal = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["personal"]!,
    name: "personal",
    description: DEPARTMENT_DESCRIPTIONS.personal,
    includeAgentName: "inline",
    middleware: agentMiddleware(PERSONAL_PROMPT),
  }).graph;

  /** Job-Hunt: researches roles + reads CV from personal-rag + HITL-drafts applications.
   *  ADR-015: personal-rag read-only; NEVER auto-submit; send_email HITL-gated. */
  const jobhunt = createAgent({
    model: deptModel,
    tools: DEPARTMENT_TOOLS["jobhunt"]!,
    name: "jobhunt",
    description: DEPARTMENT_DESCRIPTIONS.jobhunt,
    includeAgentName: "inline",
    middleware: agentMiddleware(JOBHUNT_PROMPT),
  }).graph;

  // Revenue: flat marketing+sales OR nested sub-supervisor (REVENUE_SUBGRAPH=1).
  const revenueAgents = REVENUE_SUBGRAPH_ENABLED
    ? [buildRevenueDomain()]
    : [marketing, sales];

  const coreAgents = [
    admin,
    research,
    comms,
    engineering as never,
    ...revenueAgents,
    personal,
    jobhunt,
  ];

  return createSupervisor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents: coreAgents as any,
    llm,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(buildSupervisorPrompt, supervisorBudget) as any,
    // ADR-028: Chief of Staff routes only — no business tools.
    // Context isolation (CLAUDE rule #20): only a department's FINAL message
    // crosses back to the supervisor — its internal tool calls/results never
    // pollute the supervisor's history. "last_message" is the library default;
    // we pin it explicitly so the isolation guarantee can't silently regress.
    outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),
    // Gemini (and most non-OpenAI providers) can't accept the agent name as a
    // message `name` attribute — the google-genai adapter maps name→author and
    // throws "Unknown author: supervisor". "inline" embeds the name in the
    // message CONTENT instead, which every provider accepts.
    includeAgentName: "inline",
  }).compile({ checkpointer });
}

/**
 * Get the compiled office graph (supervisor + sub-agents).
 * First call builds + compiles with the Postgres checkpointer; subsequent
 * calls return the singleton. Never compile per request.
 */
export async function getOffice() {
  if (_office) return _office;
  // Connect external MCP servers (ADR-041) and merge their tools into the
  // department registry BEFORE the graph reads DEPARTMENT_TOOLS. No-op unless
  // MCP_BRIDGE_ENABLED — flag-off leaves the registry byte-identical.
  await applyMcpBridge();
  const checkpointer = await getCheckpointer();
  // Upstream LangGraph typing bug: PostgresSaver isn't assignable to
  // BaseCheckpointSaver<number> because serde.dumpsTyped is typed sync on the
  // base but async on PostgresSaver. PostgresSaver IS a valid checkpointer at
  // runtime (tests + production prove it); cast at this single boundary so
  // `pnpm lint` stays clean instead of carrying a permanent known error.
  _office = buildOffice(checkpointer as unknown as BaseCheckpointSaver);
  log.info(
    `Office compiled: supervisor + [admin, research, comms, engineering, ${
      REVENUE_SUBGRAPH_ENABLED ? "revenue(sub)" : "marketing, sales"
    }, personal, jobhunt]`,
  );
  return _office;
}

/**
 * After an office.invoke(), check whether the graph paused on a tool that
 * requested the founder's approval. Returns the approval payload to render,
 * or null if the run completed without an interrupt.
 *
 * (In this LangGraph version, interrupts surface via getState().tasks, not on
 * the invoke() return value.)
 */
export async function getPendingApproval(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: { getState: (c: RunnableConfig) => Promise<any> },
  config: RunnableConfig,
): Promise<ApprovalRequest | null> {
  const state = await office.getState(config);
  const interrupts = ((state.tasks ?? []) as Array<{ interrupts?: Array<{ value: unknown }> }>)
    .flatMap((t) => t.interrupts ?? []);
  if (interrupts.length === 0) return null;
  return interrupts[0]!.value as ApprovalRequest;
}
