/**
 * FounderOS — Tool Registry
 * ==========================
 * Unified interface for all agent tools.
 * Agents receive a filtered subset based on allowed_tools from registry.ts.
 *
 * Adding a new tool:
 *  1. Create src/tools/{tool-name}.ts implementing UnifiedTool
 *  2. Import and register here
 *  3. Add to agent's allowed_tools in registry.ts
 */

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

export interface UnifiedTool {
  name: string;
  description: string;
  /** JSON Schema for agent parameter validation + LangChain tool binding. */
  input_schema?: ToolInputSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// ── Tool Imports ──────────────────────────────────────────────────────────────
import { webSearchTool } from "./web-search.js";
import { linkedinPostTool, linkedinAnalyticsTool, linkedinConnectTool } from "./linkedin.js";
import { emailTool } from "./email.js";
import { githubTool } from "./github.js";

// ── Registry ──────────────────────────────────────────────────────────────────

const _tools: Map<string, UnifiedTool> = new Map();

function registerTool(tool: UnifiedTool): void {
  _tools.set(tool.name, tool);
}

registerTool(webSearchTool);
registerTool(linkedinPostTool);
registerTool(linkedinAnalyticsTool);
registerTool(linkedinConnectTool);
registerTool(emailTool);
registerTool(githubTool);

/** Get a tool by name. Returns undefined if not registered. */
export function getTool(name: string): UnifiedTool | undefined {
  return _tools.get(name);
}

/** Get all tools an agent is allowed to use (filters unregistered names). */
export function getToolsForAgent(allowedTools: string[]): UnifiedTool[] {
  return allowedTools.flatMap((name) => {
    const tool = _tools.get(name);
    return tool ? [tool] : [];
  });
}

/** All registered tool names. */
export function listTools(): string[] {
  return [..._tools.keys()];
}

