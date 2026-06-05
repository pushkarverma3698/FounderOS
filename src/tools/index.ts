/**
 * FounderOS — Tool Type Definitions
 * ===================================
 * Shared interfaces used by all tool implementations.
 *
 * ARCHITECTURE NOTE: There is NO tool registry here. Tools are wired
 * directly from src/tools/{name}.ts into src/agents/agent-tools.ts
 * (LangChain wrappers + HITL gates) and then into src/agents/office.ts
 * (department createReactAgent calls). The old Map-based registry was
 * never used by the v2 office and has been removed to avoid misleading
 * the next engineer.
 *
 * Adding a new tool: see docs/TOOL-STANDARDS.md (8-point checklist).
 * Short version:
 *  1. Create src/tools/{name}.ts implementing UnifiedTool
 *  2. Write tests/unit/tools/{name}.test.ts — mock Composio, test soft-failure
 *  3. Add LangChain wrapper to src/agents/agent-tools.ts
 *  4. Wire into the right department in src/agents/office.ts
 *  5. pnpm test green + pnpm lint clean
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
