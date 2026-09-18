import { toolResolver } from "./resolver.js";
import { hitlGate } from "../../infra/hitl.js";
import type { ToolResult } from "../index.js";
import type { ToolExecutionEnv } from "./adapters/types.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "tool-gateway" });

export class ToolGateway {
  /**
   * Invokes a tool by name with the given arguments.
   * Handles resolution, approval checks, and adapter dispatch.
   */
  public async invoke(toolName: string, args: Record<string, unknown>, env?: ToolExecutionEnv): Promise<ToolResult> {
    const { tool, adapter } = toolResolver.resolve(toolName);

    log.debug({ tool: toolName, transport: tool.transport }, "Gateway routing tool execution");

    // Enforce approval policy
    if (tool.approval === "required") {
      const summary = `Tool: ${tool.name}\nTransport: ${tool.transport}`;
      const preview = JSON.stringify(args, null, 2);

      // We call hitlGate. If it returns a string, the founder rejected it.
      const rejection = await hitlGate(
        {
          action: tool.name,
          title: `Approval required for ${tool.name}`,
          summary,
          preview,
          args,
        },
        env?.config,
      );

      if (rejection) {
        return { success: false, error: rejection };
      }
    }

    try {
      return await adapter.invoke(tool, args, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ tool: toolName, err: message }, "Tool execution failed");
      return { success: false, error: message };
    }
  }
}

export const toolGateway = new ToolGateway();
