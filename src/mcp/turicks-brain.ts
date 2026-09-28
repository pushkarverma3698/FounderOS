#!/usr/bin/env node
/**
 * Tiny IDE Brain MCP (ADR-038)
 * =============================
 * Standardized read/write interface to the canonical Postgres brain for IDEs 
 * (Claude, Cursor, Antigravity). Connects to Postgres via local network or SSH tunnel.
 * No Chroma, no external vector DBs.
 * 
 * Tools:
 * - search_memory: Semantic + keyword search via searchBrain
 * - get_memory: Fetch full document or memory by ID/title
 * - remember: Ingest a general memory (note, concept, context)
 * - save_decision: Explicitly save a design or architecture decision
 * - save_bug: Log a bug, root cause, and solution
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { searchBrain } from "../db/rag-search.js";
import { brainIngest } from "../db/brain-ingest.js";
import { writeToolIngestOptions } from "./brain-write-args.js";
import { db } from "../db/client.js";
import { brainMemories } from "../db/schema.js";
import { eq, ilike, or } from "drizzle-orm";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "mcp-brain" });

const TOOLS = [
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

function formatResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function formatError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

const server = new Server(
  { name: "turicks-brain-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as any,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Tiny IDE Brain MCP started.");
}

main().catch(console.error);
