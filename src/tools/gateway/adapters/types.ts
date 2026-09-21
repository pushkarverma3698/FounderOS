import type { ToolDefinition } from "../../registry/types.js";
import type { ToolResult } from "../../index.js";

export interface ToolExecutionEnv {
  config?: any; // LangChain RunnableConfig or similar context
}

export interface ToolAdapter {
  invoke(tool: ToolDefinition, args: Record<string, unknown>, env?: ToolExecutionEnv): Promise<ToolResult>;
}
