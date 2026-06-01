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
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { CompiledStateGraph, BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel } from "./model.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import {
  searchWeb,
  sendEmail,
  linkedinPost,
  githubRead,
  githubWrite,
} from "./agent-tools.js";
import {
  SUPERVISOR_PROMPT,
  RESEARCH_PROMPT,
  COMMS_PROMPT,
  ENGINEERING_PROMPT,
  MARKETING_PROMPT,
  SALES_PROMPT,
  PROSPECTING_PROMPT,
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

  const research = createReactAgent({
    llm,
    tools: [searchWeb],
    name: "research",
    prompt: RESEARCH_PROMPT,
  });

  const comms = createReactAgent({
    llm,
    tools: [sendEmail, linkedinPost],
    name: "comms",
    prompt: COMMS_PROMPT,
  });

  const engineering = createReactAgent({
    llm,
    tools: [githubRead, githubWrite],
    name: "engineering",
    prompt: ENGINEERING_PROMPT,
  });

  // ── Phase B departments ───────────────────────────────────────────────────

  /** Marketing: LinkedIn content in Turicks brand voice. */
  const marketing = createReactAgent({
    llm,
    tools: [searchWeb, linkedinPost],
    name: "marketing",
    prompt: MARKETING_PROMPT,
  });

  /** Sales: researches prospects + writes cold outreach emails (HITL-gated). */
  const sales = createReactAgent({
    llm,
    tools: [searchWeb, sendEmail],
    name: "sales",
    prompt: SALES_PROMPT,
  });

  /** Prospecting: ICP scoring — research-only, no write tools. */
  const prospecting = createReactAgent({
    llm,
    tools: [searchWeb],
    name: "prospecting",
    prompt: PROSPECTING_PROMPT,
  });

  return createSupervisor({
    agents: [research, comms, engineering, marketing, sales, prospecting],
    llm,
    prompt: SUPERVISOR_PROMPT,
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
  _office = buildOffice(checkpointer);
  log.info("Office compiled: supervisor + [research, comms, engineering, marketing, sales, prospecting]");
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
