import type { ToolDefinition } from "../../registry/types.js";
import type { ToolAdapter, ToolExecutionEnv } from "./types.js";
import type { ToolResult } from "../../index.js";

// Currently MCP execution goes through callMcpTool or similar in the bridge.
// We will stub this to throw if invoked directly until MCP migration is complete.
// The existing `mcp/client.ts` uses its own invocation.
export class McpAdapter implements ToolAdapter {
  async invoke(tool: ToolDefinition, args: Record<string, unknown>, env?: ToolExecutionEnv): Promise<ToolResult> {
    throw new Error("McpAdapter invoke not fully implemented. MCP tools should bridge to ToolGateway.");
  }
}
