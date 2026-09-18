export type ToolLayer =
  | "founderos"
  | "runtime"
  | "integration"
  | "infrastructure";

export type ToolTransport =
  | "internal"
  | "mcp"
  | "http"
  | "cli"
  | "runtime";

export type SideEffectType =
  | "read"
  | "write"
  | "destructive";

export type ApprovalPolicy =
  | "none"
  | "required"
  | "conditional";

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;

  layer: ToolLayer;
  transport: ToolTransport;

  inputSchema: ToolInputSchema;
  outputSchema?: unknown;

  sideEffect: SideEffectType;
  approval: ApprovalPolicy;

  capabilities?: string[];

  executorRef?: string;

  enabled: boolean;

  metadata?: Record<string, unknown>;
}
