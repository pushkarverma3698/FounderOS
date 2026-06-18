/**
 * Deterministic shell HITL fast path — direct run_shell invoke in a one-node graph.
 * Full office routing was flaky: personal transferred back without calling run_shell,
 * then supervisor illegally attempted run_shell (ADR-028 violation). LLM-only personal
 * agent was also unreliable on OpenRouter. Same pattern as inbox/github fast paths (rule #16).
 */

import { Annotation, StateGraph, START, END, Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver, CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { runShell } from "../agents/agent-tools/personal.js";
import { getPendingApproval } from "../agents/office.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { extractShellCommand, isShellRunRequest } from "./execution-guard.js";

const SHELL_FP_SUFFIX = ":shell-fp";

const ShellState = Annotation.Root({
  command: Annotation<string>,
  output: Annotation<string>,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _shellHitlGraph: CompiledStateGraph<any, any, any> | undefined;

export function shellFastPathThreadId(baseThreadId: string): string {
  return `${baseThreadId}${SHELL_FP_SUFFIX}`;
}

export function isShellFastPathThread(threadId: string): boolean {
  return threadId.endsWith(SHELL_FP_SUFFIX);
}

export function buildShellHitlGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ShellState)
    .addNode("run", async (state, config) => {
      const result = await runShell.invoke({ command: state.command }, config);
      const output = typeof result === "string" ? result : String(result);
      return { output };
    })
    .addEdge(START, "run")
    .addEdge("run", END)
    .compile({ checkpointer }) as unknown as CompiledStateGraph<any, any, any>;
}

async function getShellHitlGraph(): Promise<CompiledStateGraph<any, any, any>> {
  if (!_shellHitlGraph) {
    const checkpointer = await getCheckpointer();
    _shellHitlGraph = buildShellHitlGraph(checkpointer as unknown as BaseCheckpointSaver);
  }
  return _shellHitlGraph;
}

export function isShellHitlRequest(input: string): boolean {
  return isShellRunRequest(input) && extractShellCommand(input) !== null;
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
 * Invoke deterministic shell HITL graph. Returns true when interrupt is pending.
 */
export async function invokeShellHitlFastPath(
  config: RunnableConfig,
  text: string,
): Promise<boolean> {
  if (!isShellHitlRequest(text)) return false;

  const command = extractShellCommand(text);
  if (!command) return false;

  const graph = await getShellHitlGraph();
  const shellConfig = shellFastPathConfig(config);
  await graph.invoke({ command }, shellConfig);
  const approval = await getPendingApproval(graph, shellConfig);
  return approval !== null;
}

export async function getShellHitlPendingApproval(
  config: RunnableConfig,
): Promise<Awaited<ReturnType<typeof getPendingApproval>>> {
  const graph = await getShellHitlGraph();
  return getPendingApproval(graph, shellFastPathConfig(config));
}

export async function resumeShellHitlFastPath(
  config: RunnableConfig,
  decision: "approved" | "rejected",
): Promise<{ command?: string; output?: string }> {
  const graph = await getShellHitlGraph();
  const shellConfig = shellFastPathConfig(config);
  return graph.invoke(new Command({ resume: decision }), shellConfig) as Promise<{ command?: string }>;
}

/** Reset singleton (tests). */
export function resetPersonalShellOfficeForTests(): void {
  _shellHitlGraph = undefined;
}

/** @deprecated use buildShellHitlGraph — kept for unit test compile smoke. */
export function buildPersonalShellOffice(checkpointer: BaseCheckpointSaver) {
  return buildShellHitlGraph(checkpointer);
}

/** @deprecated LLM routing removed — deterministic graph only. */
export function buildShellHitlInput(text: string) {
  const command = extractShellCommand(text)!;
  return [{ role: "system", content: `run_shell: ${command}` }];
}
