import type { ToolDefinition } from "../../registry/types.js";
import type { ToolAdapter, ToolExecutionEnv } from "./types.js";
import type { ToolResult } from "../../index.js";

export class CliAdapter implements ToolAdapter {
  async invoke(tool: ToolDefinition, args: Record<string, unknown>, env?: ToolExecutionEnv): Promise<ToolResult> {
    throw new Error("CliAdapter invoke not implemented.");
  }
}
