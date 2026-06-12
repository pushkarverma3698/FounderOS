/**
 * FounderOS MCP Server
 * ====================
 * Exposes FounderOS read-only capabilities via the Model Context Protocol.
 * Claude Code, Cursor, and any MCP-compatible client can call these tools
 * directly without going through the Telegram gateway.
 *
 * IMPORTANT — read-only contract:
 *   Only tools that require NO approval are exposed here. Write tools
 *   (send_email, linkedin_post, github_write, write_file, run_shell, browser)
 *   are intentionally excluded — they require HITL approval which only exists
 *   in the Telegram gateway flow. Exposing them here would bypass the safety gate.
 *   See ADR-013 (separation of concerns) and ADR-004 (why Telegram for HITL).
 *
 * Tools exposed:
 *   - search_web      → Gemini grounding (→ DuckDuckGo fallback) web search
 *   - github_read     → GitHub repos / README / stats (read-only)
 *   - read_context    → Founder's current business context
 *   — Memory data-source layer (ADR-016) —
 *   - search_memory   → Unified query across episodic_memory + conversations + knowledge_entries
 *   - search_knowledge → turicks-brain keyword search (knowledge_entries table)
 *   - read_cv         → personal-rag CV/career lookup (personal-rag REST API + wiki fallback)
 *
 * Transport: Streamable HTTP (MCP spec Nov 2025+)
 * Start: pnpm mcp  (or: node --env-file=.env --import tsx/esm src/mcp/index.ts)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { webSearchTool } from "../tools/web-search.js";
import { githubTool } from "../tools/github.js";
import { getFounderContext } from "../db/queries.js";
import { searchMemoryTool } from "../tools/memory.js";
import { searchKnowledge } from "../tools/knowledge.js";
import { readCvTool } from "../tools/career.js";

// ── Tool definitions ──────────────────────────────────────────────────────────

export type McpToolName =
  | "search_web"
  | "github_read"
  | "read_context"
  | "search_memory"
  | "search_knowledge"
  | "read_cv";

export const FOUNDEROS_MCP_TOOLS = [
  {
    name: "search_web" as const,
    description:
      "Search the web for current information, news, or company/market research. " +
      "Returns titles, URLs, and snippets. Read-only — no approval needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Max results to return (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "github_read" as const,
    description:
      "Read from GitHub — list repos, get a README, or fetch profile stats. " +
      "Read-only, no approval needed. Actions: list_repos, get_readme, get_stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list_repos", "get_readme", "get_stats"],
          description: "The GitHub action to perform",
        },
        owner: { type: "string", description: "GitHub username or org (optional)" },
        repo: { type: "string", description: "Repository name (required for get_readme)" },
      },
      required: ["action"],
    },
  },
  {
    name: "read_context" as const,
    description:
      "Read the founder's current business context — active clients, deals, " +
      "priorities, and next actions. Useful for understanding what's in progress.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── Memory data-source layer (ADR-016) ────────────────────────────────────

  {
    name: "search_memory" as const,
    description:
      "Search across all FounderOS memory tiers: episodic events (decisions, outcomes, " +
      "completed tasks), conversation history, turicks-brain knowledge, and founder context. " +
      "Use this to answer 'what did we decide about X', 'what happened with Y last week', " +
      "'what is our strategy on Z'. Read-only — no approval needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "What to search for, e.g. 'LangGraph HITL decisions' or 'client Naggar status'",
        },
        type: {
          type: "string",
          enum: ["all", "conversations", "episodic", "context", "knowledge"],
          description: "Filter to a specific memory tier (default: all)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_knowledge" as const,
    description:
      "Search the turicks-brain knowledge base — ADRs, brand guidelines, strategy docs, " +
      "phase summaries, post-mortems, and case studies. Use for questions about architecture " +
      "decisions, business strategy, or how FounderOS is designed. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query, e.g. 'HITL interrupt design' or 'Turicks brand voice'",
        },
        limit: {
          type: "number",
          description: "Max results (default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_cv" as const,
    description:
      "Read Pushkar Verma's CV, career background, and skills from his personal knowledge base. " +
      "Use for questions about his experience, technical skills, portfolio projects, or salary expectations. " +
      "Queries the personal-rag API (localhost:8765) or falls back to wiki.md. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "What to look up, e.g. 'LangGraph experience', 'AI agent skills', 'TypeScript projects'",
        },
      },
      required: ["query"],
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────

export interface McpContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/** Execute an MCP tool call. Returns MCP-shaped content, never throws. */
export async function handleMcpToolCall(
  name: McpToolName | string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "search_web": {
        const query = String(args["query"] ?? "");
        const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
        const res = await webSearchTool.execute({ query, limit });
        if (!res.success) {
          return errorResult(`Web search failed: ${res.error ?? "unknown error"}`);
        }
        const results = (res.data as Array<{ title: string; url: string; snippet: string }>) ?? [];
        if (results.length === 0) {
          return textResult(`No results found for "${query}".`);
        }
        const text = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        return textResult(text);
      }

      case "github_read": {
        const action = String(args["action"] ?? "get_stats") as "list_repos" | "get_readme" | "get_stats";
        const owner = args["owner"] ? String(args["owner"]) : undefined;
        const repo = args["repo"] ? String(args["repo"]) : undefined;
        const res = await githubTool.execute({ action, ...(owner ? { owner } : {}), ...(repo ? { repo } : {}) });
        if (!res.success) {
          return errorResult(`GitHub read failed: ${res.error}`);
        }
        return textResult(JSON.stringify(res.data, null, 2));
      }

      case "read_context": {
        const tenant = process.env["FOUNDER_TENANT"] ?? "turicks";
        try {
          const ctx = await getFounderContext(tenant);
          if (!ctx) return textResult("No context saved yet. Use FounderOS to set your business context.");
          return textResult(JSON.stringify(ctx.context_data, null, 2));
        } catch {
          // DB not available in some environments (e.g. Claude Code without Postgres)
          return textResult("Context unavailable — database not connected.");
        }
      }

      // ── Memory data-source layer ─────────────────────────────────────────────

      case "search_memory": {
        const query = String(args["query"] ?? "");
        const type = (args["type"] as "all" | "conversations" | "episodic" | "knowledge" | "context" | undefined) ?? "all";
        // searchMemoryTool is a LangChain DynamicStructuredTool (.invoke not .execute)
        try {
          const text = await searchMemoryTool.invoke({ query, type });
          return textResult(String(text ?? "No results found."));
        } catch (err) {
          return errorResult(`Memory search failed: ${(err as Error).message}`);
        }
      }

      case "search_knowledge": {
        const query = String(args["query"] ?? "");
        const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
        // searchKnowledge is a LangChain DynamicStructuredTool (.invoke not .execute)
        try {
          const text = await searchKnowledge.invoke({ query, ...(limit !== 5 ? { limit } : {}) });
          return textResult(String(text ?? "No knowledge entries found."));
        } catch (err) {
          return errorResult(`Knowledge search failed: ${(err as Error).message}`);
        }
      }

      case "read_cv": {
        const query = String(args["query"] ?? "skills");
        const res = await readCvTool.execute({ query });
        if (!res.success) return errorResult(`CV read failed: ${res.error ?? "unknown"}`);
        return textResult(String(res.data ?? "No CV data found."));
      }

      default:
        return errorResult(`Unknown tool: "${name}". Available tools: ${FOUNDEROS_MCP_TOOLS.map((t) => t.name).join(", ")}`);
    }
  } catch (err) {
    return errorResult(`Tool "${name}" failed: ${(err as Error).message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ── MCP Server factory ────────────────────────────────────────────────────────

/**
 * Build and wire the MCP Server instance.
 * The caller is responsible for connecting a transport.
 */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: "founderos", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: FOUNDEROS_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handleMcpToolCall(name as McpToolName, (args ?? {}) as Record<string, unknown>);
    // SDK v1.29 setRequestHandler infers a wide union return type; our shape is a valid
    // subset of CallToolResult (content + isError). Cast at this single boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result as any;
  });

  return server;
}
