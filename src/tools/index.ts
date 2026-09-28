/**
 * FounderOS — Tool Type Definitions & Tool Dispatch Validation
 * ==============================================================
 * Shared interfaces used by all tool implementations + Jev AI pre-execution tool dispatch validation.
 *
 * ARCHITECTURE NOTE: There is NO tool registry here. Tools are wired
 * directly from src/tools/{name}.ts into src/agents/agent-tools/
 * (LangChain wrappers + HITL gates) and declared per-department in
 * src/agents/capabilities.ts (the single source of truth the kernel
 * worker reads).
 */

import { validateJevToolDispatch, type JevToolValidationResult } from "../services/jev-ai.js";

export interface ObservedResult {
  kind: "file" | "http" | "record" | "commit" | "message";
  evidence: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  observed?: ObservedResult;
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

/**
 * Validates tool execution arguments using Jev AI rules before dispatch.
 */
export function validateToolDispatch(
  tool: UnifiedTool | string,
  args: Record<string, unknown>,
): JevToolValidationResult {
  const toolName = typeof tool === "string" ? tool : tool.name;
  return validateJevToolDispatch(toolName, args);
}

/**
 * Executes a tool after running Jev AI pre-execution dispatch validation checks.
 * If validation fails, short-circuits with an error result without executing the tool.
 */
export async function executeToolWithValidation(
  tool: UnifiedTool,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const validation = validateToolDispatch(tool, args);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.reason ?? "Tool dispatch validation failed",
    };
  }

  const safeArgs = (validation.sanitizedArgs ?? args) as Record<string, unknown>;
  return tool.execute(safeArgs);
}
