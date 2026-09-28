/**
 * FounderOS — brain tools (ADR-038), shared by every MCP entry point.
 * ===================================================================
 * The five read/write tools over the canonical Postgres brain
 * (brain.brain_memories): search_memory, get_memory, remember, save_decision,
 * save_bug. Moved here unchanged from turicks-brain.ts on 2026-09-28 so the hub
 * (hub.ts) and the brain-only entry (turicks-brain.ts) serve one implementation.
 */

import { searchBrain } from "../db/rag-search.js";
import { brainIngest } from "../db/brain-ingest.js";
import { writeToolIngestOptions } from "./brain-write-args.js";
import { db } from "../db/client.js";
import { brainMemories } from "../db/schema.js";
import { eq, ilike, or } from "drizzle-orm";

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export const BRAIN_TOOLS = [
  {
    name: "search_memory",
    description: "Search across the unified Postgres brain for decisions, architecture, bugs, or concepts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        topK: { type: "number", description: "Number of results to return (default 5)" },
        memoryType: { type: "string", description: "Optional filter by memory type (decision, bug, note, architecture, etc.)" },
        project: { type: "string", description: "Optional filter by project (e.g. \"oplify\") — scopes results to one project's memories." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memory",
    description: "Get a specific memory or document by source_id or title.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_title: { type: "string", description: "The source_id or title/filename of the memory." }
      },
      required: ["id_or_title"]
    }
  },
  {
    name: "remember",
    description: "Ingest a new general memory, note, or concept into the canonical brain.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (markdown supported)." },
        tags: { type: "string", description: "Comma-separated tags (e.g., 'concept, auth, notes')" },
        project: { type: "string", description: "The project this applies to (e.g. \"founderos\", \"oplify\"). Always pass it — untagged memories are invisible to project-scoped search." }
      },
      required: ["content"]
    }
  },
  {
    name: "save_decision",
    description: "Save an architectural or design decision to the brain.",
    inputSchema: {
      type: "object",
      properties: {
        decision: { type: "string", description: "The decision made and its rationale." },
        project: { type: "string", description: "The project this applies to." }
      },
      required: ["decision"]
    }
  },
  {
    name: "save_bug",
    description: "Log a bug, its root cause, and the solution to prevent future recurrence.",
    inputSchema: {
      type: "object",
      properties: {
        bug: { type: "string", description: "Description of the bug, cause, and solution." },
        project: { type: "string", description: "The project this applies to." }
      },
      required: ["bug"]
    }
  }
];

export function formatResult(text: string): McpToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function formatError(text: string): McpToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Runs one brain tool. Returns null for a name that is not a brain tool. */
export async function callBrainTool(name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
  if (!BRAIN_TOOLS.some((t) => t.name === name)) return null;
  try {
    switch (name) {
      case "search_memory": {
        const query = String(args["query"]);
        const topK = Number(args["topK"] ?? 5);
        const memoryType = args["memoryType"] ? String(args["memoryType"]) : undefined;
        const project = args["project"] ? String(args["project"]) : undefined;
        const filters = memoryType || project ? { memory_type: memoryType, project } : undefined;

        const result = await searchBrain({ query, topK, filters, table: "brain_memories" });
        if ('error' in result) {
          return formatError(`Search failed at stage ${result.error.stage}: ${result.error.message}`);
        }

        if (result.hits.length === 0) {
          return formatResult(`No relevant context found.`);
        }

        const text = result.hits.map((h, i) => {
          const m = h.metadata;
          return `--- Result ${i + 1} (Score: ${h.score.toFixed(3)}) ---\n` +
                 `Type: ${h.memory_type ?? "unknown"} | Project: ${h.project ?? "none"} | Source: ${m.source_path ?? "unknown"}\n\n` +
                 `${h.content}`;
        }).join("\n\n");
        
        return formatResult(text);
      }
      
      case "get_memory": {
        const id_or_title = String(args["id_or_title"]);
        const rows = await db
          .select()
          .from(brainMemories)
          .where(
            or(
              eq(brainMemories.source_id, id_or_title),
              ilike(brainMemories.source, `%${id_or_title}%`)
            )
          )
          .limit(5);
          
        if (rows.length === 0) return formatResult(`Memory not found.`);
        const text = rows.map((r, i) => `--- Result ${i + 1} ---\nSource: ${r.source}\nType: ${r.memory_type}\n\n${r.content}`).join("\n\n");
        return formatResult(text);
      }
      
      case "remember":
      case "save_decision":
      case "save_bug": {
        const opts = writeToolIngestOptions(name, args);
        if (!opts) return formatError(`Unknown tool: ${name}`);
        const res = await brainIngest(opts);
        const label = name === "remember" ? "Memory saved" : name === "save_decision" ? "Decision saved" : "Bug logged";
        return formatResult(`${label} (ID: ${res.id})${opts.project ? ` [project: ${opts.project}]` : " [no project tag]"}`);
      }

      default:
        return formatError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return formatError(`Tool execution failed: ${(err as Error).message}`);
  }
}
