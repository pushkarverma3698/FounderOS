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
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel } from "./model.js";
import { createTrimmedPrompt } from "../infra/context-manager.js";
import { ENGINEERING_SUBAGENT_TOOLS } from "./capabilities.js";

const workerBudget = { maxTokens: 4000 };

const CODER_PROMPT = `You are the Coder on Turicks' engineering team. You implement and fix code.
Use claude_code for any build/code/repo change (it runs in an isolated workspace and pauses for founder approval). Use github_read to inspect a repo first. Relay the executor's result verbatim — do not summarise.`;

const QA_PROMPT = `You are QA on Turicks' engineering team. You verify code: run tests, lint, and review.
Use claude_code to run the test/verification commands (it pauses for founder approval). Use github_read to inspect the repo. Report pass/fail with the real output — never claim "looks good" without evidence.`;

const DEVOPS_PROMPT = `You are DevOps on Turicks' engineering team. You ship: create issues, open PRs, push, run workflows.
To CREATE A GITHUB ISSUE you MUST call github_write with action "create_issue" and owner, repo, title, body (it pauses for founder approval). Use github_write for any repo write (issue/PR/commit/push) and project_workflow for repo workflows. Always include the exact owner, repo, and branch. NEVER claim a write succeeded without actually calling the tool.`;

const CTO_PROMPT = `You are the CTO of Turicks, supervising three engineers:
- coder → write/implement/fix/build code.
- qa → test/verify/lint/review code.
- devops → create an issue, open a PR, push, deploy, or run a repo workflow.
You have NO tools of your own — you can ONLY act by delegating to exactly ONE engineer per step.
NEVER answer a request yourself and NEVER claim a task is already done or completed without delegating —
if work is requested, you MUST route it. Routing: "build/fix/implement/write code" → coder; "test/verify/lint/review" → qa;
"create/open an issue, PR, repo, push, deploy, run a workflow, or any GitHub write" → devops.
Relay the chosen engineer's result verbatim — no preamble.`;

/**
 * Build the nested `engineering` sub-supervisor (CTO over coder+qa+devops),
 * compiled WITHOUT a checkpointer — the parent supplies persistence.
 */
export function buildEngineeringDomain() {
  const llm = getModel();
  const coder = createReactAgent({
    llm,
    tools: ENGINEERING_SUBAGENT_TOOLS["coder"]!,
    name: "coder",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(CODER_PROMPT, workerBudget) as any,
  });
  const qa = createReactAgent({
    llm,
    tools: ENGINEERING_SUBAGENT_TOOLS["qa"]!,
    name: "qa",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(QA_PROMPT, workerBudget) as any,
  });
  const devops = createReactAgent({
    llm,
    tools: ENGINEERING_SUBAGENT_TOOLS["devops"]!,
    name: "devops",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(DEVOPS_PROMPT, workerBudget) as any,
  });
  return createSupervisor({
    agents: [coder, qa, devops],
    llm,
    prompt: CTO_PROMPT,
    outputMode: "last_message",
    includeAgentName: "inline",
    supervisorName: "engineering",
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
    outputMode: "last_message",
    includeAgentName: "inline",
  }).compile({ checkpointer });
}
