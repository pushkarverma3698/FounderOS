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
import { createTrimmedPrompt } from "../infra/context-manager.js";
import {
  searchWeb,
  sendEmail,
  readEmails,
  linkedinPost,
  githubRead,
  githubWrite,
  readFile,
  listDir,
  writeFile,
  runShell,
  browser,
} from "./agent-tools.js";
import { readContext, updateContext } from "../tools/context.js";
import { searchKnowledge } from "../tools/knowledge.js";
import {
  SUPERVISOR_PROMPT,
  RESEARCH_PROMPT,
  COMMS_PROMPT,
  ENGINEERING_PROMPT,
  MARKETING_PROMPT,
  SALES_PROMPT,
  PROSPECTING_PROMPT,
  PERSONAL_PROMPT,
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

  const research = createReactAgent({
    llm,
    tools: [searchWeb, searchKnowledge, readEmails],
    name: "research",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(RESEARCH_PROMPT, subAgentBudget) as any,
  });

  const comms = createReactAgent({
    llm,
    tools: [sendEmail, readEmails, linkedinPost],
    name: "comms",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(COMMS_PROMPT, subAgentBudget) as any,
  });

  const engineering = createReactAgent({
    llm,
    tools: [githubRead, githubWrite],
    name: "engineering",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(ENGINEERING_PROMPT, subAgentBudget) as any,
  });

  // ── Phase B departments ───────────────────────────────────────────────────

  /** Marketing: LinkedIn content in Turicks brand voice. */
  const marketing = createReactAgent({
    llm,
    tools: [searchWeb, linkedinPost, searchKnowledge],
    name: "marketing",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(MARKETING_PROMPT, subAgentBudget) as any,
  });

  /** Sales: researches prospects + writes cold outreach emails (HITL-gated). */
  const sales = createReactAgent({
    llm,
    tools: [searchWeb, sendEmail, searchKnowledge],
    name: "sales",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(SALES_PROMPT, subAgentBudget) as any,
  });

  /** Prospecting: ICP scoring — research-only, no write tools. */
  const prospecting = createReactAgent({
    llm,
    tools: [searchWeb, searchKnowledge],
    name: "prospecting",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(PROSPECTING_PROMPT, subAgentBudget) as any,
  });

  /** Personal: senior engineer on the founder's laptop — files, shell, browser
   *  (write/shell/browser HITL-gated; reads are instant). */
  const personal = createReactAgent({
    llm,
    tools: [readFile, listDir, writeFile, runShell, browser],
    name: "personal",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(PERSONAL_PROMPT, subAgentBudget) as any,
  });

  return createSupervisor({
    agents: [research, comms, engineering, marketing, sales, prospecting, personal],
    llm,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(SUPERVISOR_PROMPT, supervisorBudget) as any,
    // Supervisor-level tools: context read/write (not delegated to departments)
    tools: [readContext, updateContext],
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
  log.info("Office compiled: supervisor + [research, comms, engineering, marketing, sales, prospecting, personal]");
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
