/**
 * FounderOS — Career Tools (Job-Hunt Department)
 * ================================================
 * Two read-only tools for the jobhunt department:
 *
 *   readCvTool   — queries the personal-rag API (localhost:8765) for CV/background data.
 *                  Falls back to reading wiki.md directly if the API is unavailable.
 *
 *   searchJobsTool — wraps Firecrawl web search, optimised for job postings.
 *                    Appends location to query when provided.
 *
 * Both are READ-ONLY — no HITL needed. The HITL gate fires when the agent
 * calls send_email (already gated) to submit a job application.
 *
 * ADR-015 boundary: personal-rag is READ-ONLY here. This tool NEVER writes to
 * personal-rag or turicks-brain. No auto-submit of applications — every send
 * goes through the existing HITL-gated send_email tool.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:career" });

// ── Config ────────────────────────────────────────────────────────────────────

const PERSONAL_RAG_URL = process.env["PERSONAL_RAG_URL"] ?? "http://localhost:8765";
const WIKI_FALLBACK_PATH = process.env["PERSONAL_WIKI_PATH"]
  ?? join(process.env["HOME"] ?? "/Users/pushkarverma", "Projects/personal-rag/data/wiki.md");
const FIRECRAWL_API_KEY = process.env["FIRECRAWL_API_KEY"] ?? "";
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v1/search";

// ── read_cv ───────────────────────────────────────────────────────────────────

export const readCvTool: UnifiedTool = {
  name: "read_cv",
  description:
    "Read Pushkar Verma's CV, career background, and skills from his personal knowledge base. " +
    "Use for: understanding experience relevant to a job description, answering 'what skills do we have', " +
    "fetching salary expectations, work history, or portfolio signals. Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to look up. E.g. 'LangGraph experience', 'salary expectations', 'TypeScript projects', 'AI agent skills'",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = (args["query"] as string | undefined) ?? "";

    // ── Try personal-rag REST API first ──────────────────────────────────────
    try {
      const resp = await fetch(`${PERSONAL_RAG_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: 5 }),
        signal: AbortSignal.timeout(4000),
      });

      if (resp.ok) {
        const body = (await resp.json()) as {
          query: string;
          results: Array<{ text: string; metadata: Record<string, unknown>; score: number }>;
          total: number;
        };

        if (body.results.length === 0) {
          return {
            success: true,
            data: `No specific CV entries found for "${query}". Try rephrasing the query.`,
          };
        }

        const formatted = body.results
          .map((r, i) => {
            const src = (r.metadata["source_file"] as string | undefined) ?? "wiki";
            return `${i + 1}. [${src}] ${r.text.trim()}`;
          })
          .join("\n\n");

        log.debug({ query, total: body.total }, "personal-rag API hit");
        return {
          success: true,
          data: `CV/background search for "${query}" (${body.total} results):\n\n${formatted}`,
        };
      }
    } catch {
      log.debug({ query }, "personal-rag API unavailable, falling back to wiki.md");
    }

    // ── Fallback: read wiki.md directly ──────────────────────────────────────
    try {
      const wiki = readFileSync(WIKI_FALLBACK_PATH, "utf-8");

      // Very basic keyword filter: split into sections and return matching lines
      const queryLower = query.toLowerCase();
      const lines = wiki.split("\n");
      const relevant: string[] = [];
      let inRelevantSection = false;

      for (const line of lines) {
        const lineLower = line.toLowerCase();
        if (line.startsWith("#")) {
          inRelevantSection = queryLower.split(" ").some((kw) => kw.length > 3 && lineLower.includes(kw));
        }
        if (
          inRelevantSection ||
          queryLower.split(" ").some((kw) => kw.length > 3 && lineLower.includes(kw))
        ) {
          relevant.push(line);
        }
      }

      const excerpt =
        relevant.length > 0
          ? relevant.slice(0, 60).join("\n")
          : wiki.slice(0, 2000); // fallback to first 2000 chars of wiki

      log.debug({ query, lines: relevant.length }, "wiki.md fallback used");
      return {
        success: true,
        data: `CV data (wiki fallback) for "${query}":\n\n${excerpt}`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ query, err: msg }, "Both personal-rag API and wiki.md failed");
      return {
        success: false,
        error: `Could not read CV: personal-rag API unavailable and wiki.md not found at ${WIKI_FALLBACK_PATH}. Start personal-rag with: cd ~/Projects/personal-rag && uvicorn src.api:app --port 8765`,
      };
    }
  },
};

// ── search_jobs ───────────────────────────────────────────────────────────────

export const searchJobsTool: UnifiedTool = {
  name: "search_jobs",
  description:
    "Search the web for job openings, hiring notices, and role descriptions. " +
    "Optimised for AI/agent engineering roles but works for any position. " +
    "Provide a role + company type query (e.g. 'LangGraph AI engineer Amsterdam'). Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Role and keywords, e.g. 'LangGraph senior AI engineer startup'",
      },
      location: {
        type: "string",
        description: "Optional location to append, e.g. 'Amsterdam' or 'remote EU'",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = (args["query"] as string | undefined) ?? "";
    const location = args["location"] as string | undefined;
    const fullQuery = location ? `${query} ${location} jobs hiring` : `${query} jobs hiring`;

    if (!FIRECRAWL_API_KEY) {
      log.warn("FIRECRAWL_API_KEY not set — job search unavailable");
      return { success: false, error: "Job search unavailable: FIRECRAWL_API_KEY not configured." };
    }

    try {
      const resp = await fetch(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({ query: fullQuery, limit: 8, scrapeOptions: { formats: ["markdown"] } }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        return {
          success: false,
          error: `Job search failed: Firecrawl returned ${resp.status}. Check FIRECRAWL_API_KEY.`,
        };
      }

      const body = (await resp.json()) as {
        success: boolean;
        data?: Array<{ title?: string; url?: string; description?: string; markdown?: string }>;
      };

      const results = body.data ?? [];
      if (results.length === 0) {
        return {
          success: true,
          data: `No job listings found for "${fullQuery}". Try broader keywords or check different sites.`,
        };
      }

      const formatted = results
        .map((r, i) => {
          const title = r.title ?? "(no title)";
          const url = r.url ?? "";
          const snippet = (r.description ?? r.markdown ?? "").slice(0, 300).replace(/\n+/g, " ");
          return `${i + 1}. **${title}**\n   ${url}\n   ${snippet}`;
        })
        .join("\n\n");

      log.info({ query: fullQuery, count: results.length }, "Job search completed");
      return {
        success: true,
        data: `Job search results for "${fullQuery}" (${results.length} found):\n\n${formatted}`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ query: fullQuery, err: msg }, "Job search failed");
      return { success: false, error: `Job search failed: ${msg}` };
    }
  },
};
