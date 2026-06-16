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
import { createAgentMiddleware, createTrimmedPrompt } from "../infra/context-manager.js";
import { DEPARTMENT_TOOLS, SUPERVISOR_TOOLS } from "./capabilities.js";
import { ENGINEERING_SUBGRAPH_ENABLED } from "../core/config.js";
import { buildEngineeringDomain } from "./engineering-domain.js";
import { assertContextIsolation, CONTEXT_ISOLATION_OUTPUT_MODE } from "./context-isolation.js";
import {
  buildSupervisorPrompt,
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

/**
 * Build (compile) the office graph with a given checkpointer.
 * Exported for tests (inject MemorySaver). Production uses getOffice().
 */
export function buildOffice(checkpointer: BaseCheckpointSaver) {
  const llm = getModel();

  // ── Phase C tools (available across departments) ──────────────────────────
  // search_knowledge: turicks-brain keyword search (no LLM cost)
  // read_context / update_context: supervisor-only business state

  // Token budgets (trimming happens before each LLM call, not in the checkpointer):
  //   Sub-agents: 4000 tokens — tool-focused, short working memory is enough
  //   Supervisor: 6000 tokens — needs routing context across more turns
  const subAgentBudget = { maxTokens: 4000 };
  const supervisorBudget = { maxTokens: 6000 };
  const agentMiddleware = (prompt: string | (() => string)) => [
    ...getModelFallbackMiddleware(),
    ...createAgentMiddleware(prompt, subAgentBudget),
  ];

  // research: web search + internal knowledge + ICP scoring (no read_emails — inbox stays in comms)
  const research = createAgent({
    model: llm,
    tools: DEPARTMENT_TOOLS["research"]!,
    name: "research",
    includeAgentName: "inline",
    middleware: agentMiddleware(RESEARCH_PROMPT),
  }).graph;

  // comms: Gmail + Calendar only (linkedin_post moved to marketing — single owner)
  const comms = createAgent({
    model: llm,
    tools: DEPARTMENT_TOOLS["comms"]!,
    name: "comms",
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
        model: llm,
        tools: DEPARTMENT_TOOLS["engineering"]!,
        name: "engineering",
        includeAgentName: "inline",
        middleware: agentMiddleware(ENGINEERING_PROMPT),
      }).graph;

  // ── Phase B departments ───────────────────────────────────────────────────

  /** Marketing: LinkedIn content in Turicks brand voice. */
  const marketing = createAgent({
    model: llm,
    tools: DEPARTMENT_TOOLS["marketing"]!,
    name: "marketing",
    includeAgentName: "inline",
    middleware: agentMiddleware(MARKETING_PROMPT),
  }).graph;

  /** Sales: researches prospects + writes cold outreach emails (HITL-gated). */
  const sales = createAgent({
    model: llm,
    tools: DEPARTMENT_TOOLS["sales"]!,
    name: "sales",
    includeAgentName: "inline",
    middleware: agentMiddleware(SALES_PROMPT),
  }).graph;

  /** Personal: senior engineer on the founder's laptop — files, shell, browser
   *  (write/shell/browser HITL-gated; reads are instant). */
  const personal = createAgent({
    model: llm,
    tools: DEPARTMENT_TOOLS["personal"]!,
    name: "personal",
    includeAgentName: "inline",
    middleware: agentMiddleware(PERSONAL_PROMPT),
  }).graph;

  /** Job-Hunt: researches roles + reads CV from personal-rag + HITL-drafts applications.
   *  ADR-015: personal-rag read-only; NEVER auto-submit; send_email HITL-gated. */
  const jobhunt = createAgent({
    model: llm,
    tools: DEPARTMENT_TOOLS["jobhunt"]!,
    name: "jobhunt",
    includeAgentName: "inline",
    middleware: agentMiddleware(JOBHUNT_PROMPT),
  }).graph;

  return createSupervisor({
    // 7 departments — prospecting merged into research (ICP scoring is now a research mode).
    // `engineering` may be a ReAct agent or a compiled sub-supervisor (same name);
    // createSupervisor accepts both, but the union widens the type — cast at this
    // single boundary (same as the proven nested pattern in engineering-domain.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents: [research, comms, engineering as any, marketing, sales, personal, jobhunt],
    llm,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(buildSupervisorPrompt, supervisorBudget) as any,
    // Supervisor-level tools: context read/write + unified memory search/record
    // These are NOT delegated to departments — the supervisor handles them directly.
    tools: SUPERVISOR_TOOLS,
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
  const checkpointer = await getCheckpointer();
  // Upstream LangGraph typing bug: PostgresSaver isn't assignable to
  // BaseCheckpointSaver<number> because serde.dumpsTyped is typed sync on the
  // base but async on PostgresSaver. PostgresSaver IS a valid checkpointer at
  // runtime (tests + production prove it); cast at this single boundary so
  // `pnpm lint` stays clean instead of carrying a permanent known error.
  _office = buildOffice(checkpointer as unknown as BaseCheckpointSaver);
  log.info("Office compiled: supervisor + [research, comms, engineering, marketing, sales, personal, jobhunt]");
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
