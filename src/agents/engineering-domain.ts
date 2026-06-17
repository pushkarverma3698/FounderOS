/**
 * FounderOS — Engineering domain (CTO subgraph)
 * =============================================
 * The Engineering department promoted to a sub-supervisor (the "CTO") over three
 * small ReAct workers, reusing existing HITL-gated tools (ADR-027, rule #17):
 *   coder   → [claude_code*, github_read]   implement/fix code in isolated workspace
 *   qa      → [claude_code*, github_read]   run tests / review via Claude Code
 *   devops  → [github_write*, project_workflow*]  PRs, push, workflows
 *   (* = pauses for founder approval via interrupt())
 *
 * Synchronous nesting (ADR-027): the parent calls this as an agent and waits, so a
 * 3-level-deep interrupt() still surfaces via getState().tasks (the gateway path).
 * Compiled WITHOUT its own checkpointer — the parent supplies persistence.
 * Depth capped at 2 (parent → engineering → worker); we do not nest further.
 */

import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel, getModelFallbackMiddleware } from "./model.js";
import { createAgentMiddleware } from "../infra/context-manager.js";
import { ENGINEERING_SUBAGENT_TOOLS } from "./capabilities.js";
import { assertContextIsolation, CONTEXT_ISOLATION_OUTPUT_MODE } from "./context-isolation.js";
import {
  findEngineeringHandoff,
  isolateEngineeringMessages,
} from "./handoff-engineering.js";

const workerBudget = { maxTokens: 4000 };

const CODER_PROMPT = `You are the Coder on Turicks' engineering team. You implement and fix code.
Use claude_code for any build/code/repo change (it runs in an isolated workspace and pauses for founder approval). Use github_read to inspect a repo first. Relay the executor's result verbatim — do not summarise.`;

const QA_PROMPT = `You are QA on Turicks' engineering team. You verify code: run tests, lint, and review.
Use claude_code to run the test/verification commands (it pauses for founder approval). Use github_read to inspect the repo. Report pass/fail with the real output — never claim "looks good" without evidence.`;

const DEVOPS_PROMPT = `You are DevOps on Turicks' engineering team. You ship: create issues, open PRs, push, run workflows.
To CREATE A GITHUB ISSUE you MUST call github_write with action "create_issue" and owner, repo, title, body (it pauses for founder approval). Use github_write for any repo write (issue/PR/commit/push) and project_workflow for repo workflows. Always include the exact owner, repo, and branch. NEVER claim a write succeeded without actually calling the tool.`;

const CTO_PROMPT = `You are the CTO of Turicks, supervising three engineers:
- coder → write/implement/fix/build code OR read/list/inspect/query a GitHub repo, branch, issue, or file.
- qa → test/verify/lint/review code (also reads repos to verify).
- devops → create an issue, open a PR, push, deploy, or run a repo workflow (WRITE-only actions).
You have NO tools of your own — you can ONLY act by delegating to exactly ONE engineer per step.
NEVER answer a request yourself and NEVER claim a task is already done or completed without delegating —
if work is requested, you MUST route it.
Routing rules (choose ONE):
  "build/fix/implement/write/generate code" → coder
  "list/read/show/inspect/query a repo, branch, file, or issue (read-only)" → coder
  "test/verify/lint/review" → qa
  "create issue/PR, push, deploy, run a workflow, or any GitHub write" → devops
Relay the chosen engineer's result verbatim — no preamble.
You receive an ENGINEERING_HANDOFF typed slice (taskBrief, owner, repo, branch, cwd) — use only those fields.`;

/** P3: CTO LLM input is the typed slice only — not full supervisor routing bloat. */
function engineeringHandoffPreModelHook(state: { messages: Parameters<typeof findEngineeringHandoff>[0] }) {
  const handoff = findEngineeringHandoff(state.messages);
  if (!handoff) return {};
  return { llmInputMessages: isolateEngineeringMessages(state.messages, handoff) };
}

/**
 * Build the nested `engineering` sub-supervisor (CTO over coder+qa+devops),
 * compiled WITHOUT a checkpointer — the parent supplies persistence.
 */
export function buildEngineeringDomain() {
  const llm = getModel();
  const agentMiddleware = (prompt: string) => [
    ...getModelFallbackMiddleware(),
    ...createAgentMiddleware(prompt, workerBudget),
  ];
  const coder = createAgent({
    model: llm,
    tools: ENGINEERING_SUBAGENT_TOOLS["coder"]!,
    name: "coder",
    includeAgentName: "inline",
    middleware: agentMiddleware(CODER_PROMPT),
  }).graph;
  const qa = createAgent({
    model: llm,
    tools: ENGINEERING_SUBAGENT_TOOLS["qa"]!,
    name: "qa",
    includeAgentName: "inline",
    middleware: agentMiddleware(QA_PROMPT),
  }).graph;
  const devops = createAgent({
    model: llm,
    tools: ENGINEERING_SUBAGENT_TOOLS["devops"]!,
    name: "devops",
    includeAgentName: "inline",
    middleware: agentMiddleware(DEVOPS_PROMPT),
  }).graph;
  return createSupervisor({
    agents: [coder, qa, devops],
    llm,
    prompt: CTO_PROMPT,
    outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),
    includeAgentName: "inline",
    supervisorName: "engineering",
    preModelHook: engineeringHandoffPreModelHook,
  }).compile({ name: "engineering" });
}

/**
 * Build a PARENT supervisor over [engineering(sub-supervisor)] for the isolation
 * integration test — compiled with the given checkpointer (HITL crash-safe).
 * Exported for tests only; production wiring happens in a later phase.
 */
export function buildEngineeringNestedOffice(checkpointer: BaseCheckpointSaver) {
  const llm = getModel();
  const engineering = buildEngineeringDomain();
  const NESTED_PARENT_PROMPT = `You are the Chief of Staff for Turicks. For anything about code,
repositories, building, testing, PRs, or deployment, route to the engineering team and relay its
result verbatim. No preamble.`;
  return createSupervisor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents: [engineering as any],
    llm,
    prompt: NESTED_PARENT_PROMPT,
    outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),
    includeAgentName: "inline",
  }).compile({ checkpointer });
}
