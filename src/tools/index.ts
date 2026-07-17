/**
 * FounderOS — Tool Type Definitions
 * ===================================
 * Shared interfaces used by all tool implementations.
 *
 * ARCHITECTURE NOTE: There is NO tool registry here. Tools are wired
 * directly from src/tools/{name}.ts into src/agents/agent-tools/
 * (LangChain wrappers + HITL gates) and declared per-department in
 * src/agents/capabilities.ts (the single source of truth the kernel
 * worker reads). The old Map-based registry was never used and has
 * been removed to avoid misleading the next engineer.
 *
 * Adding a new tool: see docs/rules/TOOL-STANDARDS.md (8-point checklist).
 * Short version:
 *  1. Create src/tools/{name}.ts implementing UnifiedTool
 *  2. Write tests/unit/tools/{name}.test.ts — mock the provider, test soft-failure
 *  3. Add LangChain wrapper under src/agents/agent-tools/
 *  4. Register it for the right department in src/agents/capabilities.ts
 *  5. pnpm gate green (lint + build + wiring + arch + tests)
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
