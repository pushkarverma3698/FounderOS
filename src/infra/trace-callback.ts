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

/** Best-effort tool name from the Serialized id array LangChain passes. */
function toolName(serialized: Serialized | undefined, runName?: string): string {
  if (runName) return runName;
  const id = (serialized as { id?: string[] } | undefined)?.id;
  return id?.[id.length - 1] ?? "unknown";
}

export class TraceCallback extends BaseCallbackHandler {
  name = "TraceCallback";

  constructor(private readonly trace: TurnTrace) {
    super();
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    _runId?: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.trace.event("tool.call", { tool: toolName(tool, runName), input: String(input).slice(0, 200) });
  }

  override async handleToolEnd(
    output: unknown,
    _runId?: string,
    _parentRunId?: string,
    _tags?: string[],
  ): Promise<void> {
    this.trace.event("tool.result", { preview: String(output).slice(0, 200) });
  }

  override async handleToolError(
    err: Error,
    _runId?: string,
    _parentRunId?: string,
    _tags?: string[],
  ): Promise<void> {
    this.trace.event("tool.error", { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
  }

  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    _runId?: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.trace.event("llm.call", { model: toolName(llm, runName) });
  }
}
