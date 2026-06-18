/**
 * FounderOS — Trace Callback
 * ===========================
 * LangChain callback that turns in-graph steps (tool calls, LLM calls) into
 * TurnTrace events with real timing — the gateway can't see inside office.invoke()
 * otherwise. Mirrors BudgetGuardCallback (src/infra/budget.ts): attach to
 * office.invoke({ callbacks: [new TraceCallback(trace)] }).
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { TurnTrace } from "./trace.js";
import { hierarchyDepth } from "./trace.js";

/** Best-effort tool name from the Serialized id array LangChain passes. */
export function resolveToolRunName(serialized: Serialized | undefined, runName?: string): string {
  if (runName) return runName;
  const id = (serialized as { id?: string[] } | undefined)?.id;
  return id?.[id.length - 1] ?? "unknown";
}

/** Collects tool run names during office.invoke — used by execution guards when dept tool messages are hidden. */
export class ToolNameCollector extends BaseCallbackHandler {
  name = "ToolNameCollector";
  readonly tools: string[] = [];

  override async handleToolStart(
    tool: Serialized,
    _input: string,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const name = resolveToolRunName(tool, runName);
    if (name && !name.startsWith("transfer_to_")) this.tools.push(name);
  }
}

function toolName(serialized: Serialized | undefined, runName?: string): string {
  return resolveToolRunName(serialized, runName);
}

export class TraceCallback extends BaseCallbackHandler {
  name = "TraceCallback";

  constructor(private readonly trace: TurnTrace) {
    super();
  }

  override async handleChainStart(
    chain: Serialized,
    _inputs: unknown,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const agent = toolName(chain, runName);
    const depth = hierarchyDepth(agent);
    if (depth !== null) {
      this.trace.event("hierarchy.enter", { agent, depth, parentRunId: _parentRunId ?? null });
    }
  }

  override async handleChainEnd(
    _outputs: unknown,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const agent = runName ?? "unknown";
    const depth = hierarchyDepth(agent);
    if (depth !== null) {
      this.trace.event("hierarchy.exit", { agent, depth, parentRunId: _parentRunId ?? null });
    }
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.trace.event("tool.call", { tool: toolName(tool, runName), input: String(input).slice(0, 200) });
  }

  override async handleToolEnd(
    output: unknown,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
  ): Promise<void> {
    const preview =
      typeof output === "string" ? output : JSON.stringify(output) ?? String(output);
    this.trace.event("tool.result", { preview: preview.slice(0, 200) });
  }

  override async handleToolError(
    err: Error,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
  ): Promise<void> {
    this.trace.event("tool.error", { error: err.message.slice(0, 200) });
  }

  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    _runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.trace.event("llm.call", { model: toolName(llm, runName) });
  }
}
