import type { ToolDefinition } from "./types.js";

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * Registers a tool. Throws if a tool with the same ID or name already exists,
   * unless duplicate logic handles it (e.g., throwing an error).
   */
  public register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool with name "${tool.name}" is already registered.`);
    }
    // ensure ID is also unique if we have a separate map for ID, but here ID is same as name or we index by name
    const existingById = Array.from(this.tools.values()).find(t => t.id === tool.id);
    if (existingById) {
      throw new Error(`Tool with ID "${tool.id}" is already registered.`);
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * Unregisters a tool by name.
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Retrieves a tool by its name.
   */
  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Retrieves a tool by its ID.
   */
  public getToolById(id: string): ToolDefinition | undefined {
    return Array.from(this.tools.values()).find(t => t.id === id);
  }

  /**
   * Returns all registered tools.
   */
  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Filters tools by layer.
   */
  public getToolsByLayer(layer: ToolDefinition["layer"]): ToolDefinition[] {
    return this.listTools().filter((t) => t.layer === layer);
  }

  /**
   * Discovers tools by a specific capability tag.
   */
  public getToolsByCapability(capability: string): ToolDefinition[] {
    return this.listTools().filter((t) => t.capabilities?.includes(capability));
  }

  /**
   * Returns only enabled tools.
   */
  public getEnabledTools(): ToolDefinition[] {
    return this.listTools().filter((t) => t.enabled);
  }

  /**
   * Returns the schema for a specific tool.
   */
  public getToolSchema(name: string): ToolDefinition["inputSchema"] | undefined {
    const tool = this.getTool(name);
    return tool?.inputSchema;
  }
}

// Global singleton for the application
export const toolRegistry = new ToolRegistry();
