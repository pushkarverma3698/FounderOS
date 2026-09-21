import { toolRegistry } from "../registry/registry.js";
import type { ToolDefinition } from "../registry/types.js";
import type { ToolAdapter } from "./adapters/types.js";
import { InternalFunctionAdapter } from "./adapters/internal.js";
import { McpAdapter } from "./adapters/mcp.js";
import { HttpAdapter } from "./adapters/http.js";
import { CliAdapter } from "./adapters/cli.js";
import { RuntimeAdapter } from "./adapters/runtime.js";

export class ToolResolver {
  private adapters: Map<ToolDefinition["transport"], ToolAdapter> = new Map();

  constructor() {
    this.adapters.set("internal", new InternalFunctionAdapter());
    this.adapters.set("mcp", new McpAdapter());
    this.adapters.set("http", new HttpAdapter());
    this.adapters.set("cli", new CliAdapter());
    this.adapters.set("runtime", new RuntimeAdapter());
  }

  /**
   * Resolves a tool by name and returns its definition along with the appropriate adapter.
   */
  public resolve(toolName: string): { tool: ToolDefinition; adapter: ToolAdapter } {
    const tool = toolRegistry.getTool(toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found in registry.`);
    }

    if (!tool.enabled) {
      throw new Error(`Tool "${toolName}" is disabled.`);
    }

    const adapter = this.adapters.get(tool.transport);
    if (!adapter) {
      throw new Error(`No adapter found for transport "${tool.transport}".`);
    }

    return { tool, adapter };
  }

  public registerAdapter(transport: ToolDefinition["transport"], adapter: ToolAdapter): void {
    this.adapters.set(transport, adapter);
  }
}

export const toolResolver = new ToolResolver();
