import type { ToolDefinition } from "../../registry/types.js";
import type { ToolAdapter, ToolExecutionEnv } from "./types.js";
import type { ToolResult } from "../../index.js";

type InternalExecutor = (args: Record<string, unknown>, env?: ToolExecutionEnv) => Promise<ToolResult>;

export class InternalFunctionAdapter implements ToolAdapter {
  private executors: Map<string, InternalExecutor> = new Map();

  public registerExecutor(ref: string, executor: InternalExecutor): void {
    this.executors.set(ref, executor);
  }

  async invoke(tool: ToolDefinition, args: Record<string, unknown>, env?: ToolExecutionEnv): Promise<ToolResult> {
    if (!tool.executorRef) {
      throw new Error(`Internal tool "${tool.name}" is missing executorRef.`);
    }

    const executor = this.executors.get(tool.executorRef);
    if (!executor) {
      throw new Error(`No internal executor registered for ref "${tool.executorRef}".`);
    }

    return await executor(args, env);
  }
}

export const internalAdapter = new InternalFunctionAdapter();
