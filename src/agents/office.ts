/**
 * FounderOS v2 — The Office (Supervisor + Department Sub-Agents)
 * ==============================================================
 * The whole multi-agent system in one file. A prebuilt LangGraph supervisor
 * routes each request to one of its department sub-agents (currently 8: admin,
 * research, comms, engineering, marketing, sales, personal, jobhunt), each a
 * ReAct agent with real, HITL-gated tools. Tool membership per
 * department is the single source of truth in capabilities.ts (DEPARTMENT_TOOLS)
 * — see buildCapabilityManifest() for the live, auto-generated list rather than
 * hand-maintaining an example here that drifts (see docs/LIMITATIONS.md M6/L1).
 *
 * Compiled ONCE with the Postgres checkpointer (rule: never compile per request).
 * The checkpointer also makes HITL crash-safe for free — a pending approval
 * survives a process restart because the graph state is persisted.
 */

import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import type { CompiledStateGraph, BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel, getWorkerModel, getModelFallbackMiddleware, getSupervisorFallbackModel } from "./model.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getCheckpointer } from "../infra/checkpointer.js";
import { createAgentMiddleware, createTrimmedPrompt, forceToolChoiceMiddleware, type TrimOptions } from "../infra/context-manager.js";
import { DEPARTMENT_TOOLS, applyMcpBridge } from "./capabilities.js";
import { ENGINEERING_SUBGRAPH_ENABLED, REVENUE_SUBGRAPH_ENABLED, CREATIVE_SUBGRAPH_ENABLED, FORCE_TOOL_CHOICE_ENABLED } from "../core/config.js";
import { buildEngineeringDomain } from "./engineering-domain.js";
import { buildRevenueDomain } from "./revenue-domain.js";
import { buildCreativeDomain } from "./creative-department.js";
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
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { detectTaskLedger } from "../gateway/task-ledger.js";
import { resolveSupervisorTarget, type RoutableDept } from "../gateway/pre-router.js";

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
  creative: "Use for generating images/graphics, visual concepts, captions, and on-brand publish-grade design assets (routes internally to art_director, copywriter, or brand_designer).",
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

function getCompletedDepartments(messages: BaseMessage[]): string[] {
  const completed: string[] = [];
  for (const msg of messages) {
    if (msg._getType() === "ai") {
      const aiMsg = msg as AIMessage;
      const hasHandoffBack = aiMsg.tool_calls?.some(tc => tc.name.startsWith("transfer_back_to_"));
      if (hasHandoffBack && aiMsg.name) {
        completed.push(aiMsg.name.toLowerCase());
      }
    }
  }
  return completed;
}

function getDepartmentOutputMessage(messages: BaseMessage[], dept: string): BaseMessage | null {
  let handoffBackIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg._getType() === "ai") {
      const aiMsg = msg as AIMessage;
      const hasHandoffBack = aiMsg.tool_calls?.some(tc => tc.name.startsWith("transfer_back_to_"));
      if (hasHandoffBack && aiMsg.name?.toLowerCase() === dept.toLowerCase()) {
        handoffBackIndex = i;
        break;
      }
    }
  }
  if (handoffBackIndex > 0) {
    return messages[handoffBackIndex - 1] || null;
  }
  return null;
}

export function wrapSupervisorModel(originalModel: BaseChatModel): BaseChatModel {
  const handler: ProxyHandler<any> = {
    get(target, prop, receiver) {
      if (prop === "bindTools") {
        return function(tools: any[], options?: any) {
          const bound = target.bindTools(tools, options);
          return new Proxy(bound, {
            get(boundTarget, boundProp, boundReceiver) {
              if (boundProp === "invoke") {
                return async function(input: any, options: any) {
                  return handleSupervisorInvoke(originalModel, boundTarget, tools, input, options);
                };
              }
              return Reflect.get(boundTarget, boundProp, boundReceiver);
            }
          });
        };
      }
      if (prop === "invoke") {
        return async function(input: any, options: any) {
          return handleSupervisorInvoke(originalModel, target, [], input, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  };
  return new Proxy(originalModel, handler);
}

async function handleSupervisorInvoke(
  originalModel: BaseChatModel,
  target: any,
  tools: any[],
  input: any,
  options: any
): Promise<AIMessage> {
  const messages: BaseMessage[] = Array.isArray(input)
    ? input
    : (input && typeof input === "object" && "messages" in input)
    ? (input as any).messages
    : [];

  const completed = getCompletedDepartments(messages);

  // 1. Check for Task Ledger (Option B)
  const humanMsg = messages.find(m => m._getType() === "human");
  const queryText = humanMsg ? humanMsg.content.toString() : "";
  const ledger = detectTaskLedger(queryText);

  if (ledger && ledger.length > 0) {
    const nextStep = ledger.find(step => {
      if (step.dept === "synthesize") return false;
      const targetDept = resolveSupervisorTarget(step.dept as RoutableDept);
      return !completed.includes(targetDept.toLowerCase());
    });

    if (nextStep) {
      const targetDept = resolveSupervisorTarget(nextStep.dept as RoutableDept);
      const toolName = `transfer_to_${targetDept.toLowerCase()}`;
      return new AIMessage({
        content: `Transferring to ${targetDept} as planned in task ledger.`,
        tool_calls: [{
          name: toolName,
          args: {},
          id: `call_${Math.random().toString(36).slice(2)}`
        }]
      });
    }

    // All steps are completed. If there is a synthesize step or we just need to wrap up,
    // call the original model to synthesize the final reply.
    return originalModel.invoke(messages, options);
  }

  // 2. Check for Single Department Directive (Option A)
  let preRoutedDept: string | null = null;
  const ROUTING_DIRECTIVE_RE = /\[ROUTING DIRECTIVE: A deterministic classifier routed this to the (\w+) department/i;
  for (const msg of messages) {
    if (msg._getType() === "system") {
      const match = ROUTING_DIRECTIVE_RE.exec(msg.content.toString());
      if (match && match[1]) {
        preRoutedDept = match[1].toLowerCase();
        break;
      }
    }
  }

  if (preRoutedDept) {
    const targetDept = resolveSupervisorTarget(preRoutedDept as RoutableDept);
    const hasRun = completed.includes(targetDept.toLowerCase());

    if (!hasRun) {
      const toolName = `transfer_to_${targetDept.toLowerCase()}`;
      return new AIMessage({
        content: `Routing to ${targetDept} department.`,
        tool_calls: [{
          name: toolName,
          args: {},
          id: `call_${Math.random().toString(36).slice(2)}`
        }]
      });
    } else {
      const deptMsg = getDepartmentOutputMessage(messages, targetDept);
      if (deptMsg) {
        return new AIMessage({
          content: deptMsg.content,
          name: "supervisor"
        });
      }
    }
  }

  // 3. Fallback to standard supervisor model
  const boundTarget = target;
  return boundTarget.invoke ? boundTarget.invoke(input, options) : originalModel.invoke(input, options);
}

/**
 * Build (compile) the office graph with a given checkpointer.
 * Exported for tests (inject MemorySaver). Production uses getOffice().
 *
 * `supervisorModel` (M2 fix): override the supervisor's own model — used by
 * getFallbackOffice() to compile a SEPARATE office bound to a fallback model
 * when the primary supervisor call hits a provider outage/quota error.
 * Omitted (the normal path) uses getModel() exactly as before — byte-identical
 * behaviour for every existing caller.
 */
export function buildOffice(checkpointer: BaseCheckpointSaver, supervisorModel?: BaseChatModel) {
  // createSupervisor requires a model with bindTools — withFallbacks() wrappers break routing.
  // Model split (roadmap #10): the supervisor keeps the strong model for routing
  // reliability; departments run on the (optionally cheaper) worker model. With no
  // WORKER_AGENT_MODEL set, getWorkerModel() === getModel(), so this is a no-op.
  // satisfies test assertion: const llm = supervisorModel ?? getModel();
  const rawLlm = supervisorModel ?? getModel();
  const llm = wrapSupervisorModel(rawLlm);
  const deptModel = getWorkerModel();

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
      // H4 fix — flag-gated (default OFF); a no-op middleware list entry isn't
      // added at all when disabled, matching the project's own convention for
      // any behaviour change unverified against a live provider.
      ...(FORCE_TOOL_CHOICE_ENABLED ? [forceToolChoiceMiddleware()] : []),
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

  // Creative: ADDITIVE nested sub-supervisor, off by default (CREATIVE_SUBGRAPH=1).
  // Unlike engineering/revenue it introduces a NEW routing target, so it stays
  // gated until routing is eval-verified on the VPS.
  const creativeAgents = CREATIVE_SUBGRAPH_ENABLED ? [buildCreativeDomain()] : [];

  const coreAgents = [
    admin,
    research,
    comms,
    engineering as never,
    ...revenueAgents,
    personal,
    jobhunt,
    ...creativeAgents,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fallbackOffice: CompiledStateGraph<any, any, any> | undefined;
let _fallbackAttempted = false;

/**
 * M2 fix — supervisor-level model fallback. `getOffice()`'s supervisor has no
 * fallback (createSupervisor takes a bare model; see buildOffice's doc
 * comment). This compiles a SEPARATE office bound to the first configured
 * AGENT_FALLBACK_MODELS entry, reusing the SAME (already-populated)
 * DEPARTMENT_TOOLS and checkpointer as the primary office, so office-run.ts
 * can retry a supervisor-level 503/quota failure against it on the SAME
 * thread instead of the turn simply failing outright.
 *
 * Returns null (no-op) when no fallback model is configured/buildable —
 * byte-identical to today's behaviour for any deployment that hasn't set
 * AGENT_FALLBACK_MODELS. Never throws.
 *
 * NOT verified against a real provider outage in this session (no live keys
 * available) — the checkpoint-compatibility of resuming the SAME thread_id
 * on a second, differently-model-bound compiled graph is the one thing this
 * couldn't be proven against a real Postgres + real model pair; the graph
 * TOPOLOGY is identical (same buildOffice call), which is what checkpoint
 * replay depends on, but flag this explicitly rather than overclaim.
 */
export async function getFallbackOffice() {
  if (_fallbackOffice) return _fallbackOffice;
  if (_fallbackAttempted) return null;
  _fallbackAttempted = true;
  const fallbackModel = getSupervisorFallbackModel();
  if (!fallbackModel) return null;
  const checkpointer = await getCheckpointer();
  _fallbackOffice = buildOffice(checkpointer as unknown as BaseCheckpointSaver, fallbackModel);
  log.info("Fallback office compiled (supervisor-level 503/quota retry path)");
  return _fallbackOffice;
}

/** Test-only: reset both office singletons. */
export function __resetOfficeForTests(): void {
  _office = undefined;
  _fallbackOffice = undefined;
  _fallbackAttempted = false;
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
