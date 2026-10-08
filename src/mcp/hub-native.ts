/**
 * FounderOS hub: the bot's own read tools (AG-042).
 * ==================================================
 * Scope "all" of the hub also serves the READ-ONLY tools FounderOS's Telegram bot binds, under a
 * `fos_` prefix, so a coding tool can ask what is deployed, what is in flight, what is in the logs
 * without a Telegram round trip.
 *
 * No second implementation and no copied schema: each entry is the very tool object in
 * DEPARTMENT_TOOLS, and its input schema is derived from that tool's own zod schema.
 *
 * Read-only is enforced three ways, and a new tool gets in only by passing all of them:
 *   1. HUB_NATIVE_TOOL_NAMES is a static allowlist; adding a tool to the bot exposes nothing.
 *   2. buildNativeHubTools refuses unless isReadOnlyTool(name) (the AG-035 list, which fails closed
 *      and excludes every HITL-gated tool) and the bot binds a tool of that name.
 *   3. tests/unit/mcp/hub-native.test.ts scans the tool sources for the approval gate and fails.
 * Writes stay in Telegram, where the founder approves them.
 *
 * Tools run with NO LangChain config: no thread_id, so no private chat is readable through the hub.
 * recall_conversation, read_file, list_dir, read_emails and the LinkedIn account reads are left out
 * on purpose: they read chats, the VPS filesystem, mail or the founder's social accounts.
 */

import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { isStructuredToolFailure } from "../agents/tool-result.js";
import { isReadOnlyTool } from "../kernel/step-budget.js";
import { formatError, formatResult, type McpToolResult } from "./brain-tools.js";

export const NATIVE_PREFIX = "fos_";

/** The bot tools the hub serves. Every name must also pass isReadOnlyTool. */
export const HUB_NATIVE_TOOL_NAMES = [
  "github_read",
  "ops_state",
  "read_context",
  "search_knowledge",
  "search_memory",
  "search_research_cache",
  "read_cv",
  "antigravity_task_status",
  "get_gap_scans",
  "list_scheduled",
  "list_scheduled_posts",
  "list_reminders",
  "list_workflows",
  "list_pending_signals",
  "list_brand_assets",
  "list_video_brands",
  "video_production_status",
  "read_logs",
] as const;

/** The part of a bot tool the hub touches. A LangChain tool satisfies it. */
export interface NativeSource {
  name: string;
  description?: string;
  schema: unknown;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

export interface NativeHubTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface NativeHubTools {
  tools: NativeHubTool[];
  /** The bot tool object behind a hub name, for tests and audits. */
  sourceOf(hubName: string): NativeSource | undefined;
  /** Runs a native tool. Null when the name is not one, so the hub can fall through. */
  run(hubName: string, args: Record<string, unknown>): Promise<McpToolResult | null>;
}

const MAX_CHARS = 60000;

function capped(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + TRUNCATED;
}
const TRUNCATED = " ...[truncated: result exceeded 60000 characters]";

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  const body = (value as Record<string, unknown> | null)?.["content"];
  if (typeof body === "string") return body as string;
  return JSON.stringify(value ?? null);
}

/** Refuses anything the bot does not bind or the AG-035 list does not class read-only. */
export function buildNativeHubTools(sources: readonly NativeSource[], names: readonly string[]): NativeHubTools {
  const bound = new Map(sources.map((s) => [s.name, s] as const));
  const byHubName = new Map<string, NativeSource>();
  const tools: NativeHubTool[] = [];
  for (const name of names) {
    if (!isReadOnlyTool(name)) fail(NOT_READ_ONLY + name);
    const source = bound.get(name);
    if (!source) fail(NOT_BOUND + name);
    const schema = { ...(toJsonSchema(source.schema as never) as Record<string, unknown>) };
    delete schema["$schema"];
    if (schema["type"] !== OBJ) fail(NO_OBJECT_SCHEMA + name);
    const hubName = NATIVE_PREFIX + name;
    byHubName.set(hubName, source);
    tools.push({ name: hubName, description: labelOf(source), inputSchema: schema });
  }
  return {
    tools,
    sourceOf: (hubName) => byHubName.get(hubName),
    run: async (hubName, args) => {
      const source = byHubName.get(hubName);
      if (!source) return null;
      try {
        const body = capped(stringify(await source.invoke(args)));
        return isStructuredToolFailure(body) ? formatError(body) : formatResult(body);
      } catch (err) {
        return formatError(capped(err instanceof Error ? err.message : String(err)));
      }
    },
  };
}

const OBJ = "object";
const NOT_READ_ONLY = "Refusing to expose this tool in the hub: it is not classed read-only (AG-035): ";
const NOT_BOUND = "Cannot expose this tool in the hub: the bot binds no tool of that name: ";
const NO_OBJECT_SCHEMA = "Cannot expose this tool in the hub: its input schema is not an object: ";

function fail(message: string): never {
  throw new Error(message);
}

function labelOf(source: NativeSource): string {
  return (source.description ?? source.name).trim() + READ_ONLY_TAG;
}
const READ_ONLY_TAG = " [FounderOS, read-only]";

/** Loads the bot's own tool objects. Lazy: scope brain never imports the agent graph. */
export async function loadNativeHubTools(): Promise<NativeHubTools> {
  const { DEPARTMENT_TOOLS } = await import("../agents/capabilities.js");
  const sources = Object.values(DEPARTMENT_TOOLS).flat() as unknown as NativeSource[];
  return buildNativeHubTools(sources, HUB_NATIVE_TOOL_NAMES);
}
