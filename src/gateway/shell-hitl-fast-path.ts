/**
 * Deterministic shell HITL fast path — personal-only ReAct agent with run_shell.
 * Full office routing was flaky: personal transferred back without calling run_shell,
 * then supervisor illegally attempted run_shell (ADR-028 violation). Same pattern as
 * inbox/github fast paths — bypass supervisor for a known HITL shape (rule #16).
 */

import { createAgent } from "langchain";
import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver, CompiledStateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getModel, getModelFallbackMiddleware } from "../agents/model.js";
import { createAgentMiddleware } from "../infra/context-manager.js";
import { runShell } from "../agents/agent-tools/personal.js";
import { getPendingApproval } from "../agents/office.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { extractShellCommand, isShellRunRequest } from "./execution-guard.js";

const SHELL_ONLY_PROMPT =
  "You are the Personal department. When asked to run a shell command, call run_shell immediately. " +
  "Never claim execution without the approval card. Never transfer to another department.";

const SHELL_FP_SUFFIX = ":shell-fp";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _personalShellOffice: CompiledStateGraph<any, any, any> | undefined;

export function shellFastPathThreadId(baseThreadId: string): string {
  return `${baseThreadId}${SHELL_FP_SUFFIX}`;
}

export function isShellFastPathThread(threadId: string): boolean {
  return threadId.endsWith(SHELL_FP_SUFFIX);
}

export function buildPersonalShellOffice(checkpointer: BaseCheckpointSaver) {
  return createAgent({
    model: getModel(),
    tools: [runShell],
    name: "personal",
    checkpointer,
    includeAgentName: "inline",
    middleware: [
      ...getModelFallbackMiddleware(),
      ...createAgentMiddleware(SHELL_ONLY_PROMPT, { maxTokens: 2000 }),
    ],
  }).graph as unknown as CompiledStateGraph<any, any, any>;
}

async function getPersonalShellOffice(): Promise<CompiledStateGraph<any, any, any>> {
  if (!_personalShellOffice) {
    const checkpointer = await getCheckpointer();
    _personalShellOffice = buildPersonalShellOffice(
      checkpointer as unknown as BaseCheckpointSaver,
    );
  }
  return _personalShellOffice;
}

export function isShellHitlRequest(input: string): boolean {
  return isShellRunRequest(input) && extractShellCommand(input) !== null;
}

export function buildShellHitlInput(text: string): BaseMessage[] {
  const command = extractShellCommand(text)!;
  return [
    new SystemMessage(`Call run_shell NOW with command: """${command}"""`),
    new HumanMessage("[Route directly to personal department]: Execute shell command."),
  ];
}

export function shellFastPathConfig(baseConfig: RunnableConfig): RunnableConfig {
  const threadId = String(baseConfig.configurable?.["thread_id"] ?? "default");
  return {
    ...baseConfig,
    configurable: {
      ...baseConfig.configurable,
      thread_id: shellFastPathThreadId(threadId),
    },
  };
}

/**
 * Invoke personal-only shell graph. Returns true when HITL interrupt is pending.
 */
export async function invokeShellHitlFastPath(
  config: RunnableConfig,
  text: string,
): Promise<boolean> {
  if (!isShellHitlRequest(text)) return false;

  const office = await getPersonalShellOffice();
  const shellConfig = shellFastPathConfig(config);
  await office.invoke({ messages: buildShellHitlInput(text) }, shellConfig);
  const approval = await getPendingApproval(office, shellConfig);
  return approval !== null;
}

export async function getShellHitlPendingApproval(
  config: RunnableConfig,
): Promise<Awaited<ReturnType<typeof getPendingApproval>>> {
  const office = await getPersonalShellOffice();
  return getPendingApproval(office, shellFastPathConfig(config));
}

export async function resumeShellHitlFastPath(
  config: RunnableConfig,
  decision: "approved" | "rejected",
): Promise<{ messages?: unknown[] }> {
  const office = await getPersonalShellOffice();
  const shellConfig = shellFastPathConfig(config);
  return office.invoke(new Command({ resume: decision }), shellConfig) as Promise<{ messages?: unknown[] }>;
}

/** Reset singleton (tests). */
export function resetPersonalShellOfficeForTests(): void {
  _personalShellOffice = undefined;
}
