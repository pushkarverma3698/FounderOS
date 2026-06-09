/**
 * FounderOS — Unified Memory Search + Event Recording Tools
 * ===========================================================
 * Two tools:
 *
 *   search_memory  — read-only, no HITL. Routes a query across:
 *                    1. episodic_memory  (time-ordered events)
 *                    2. knowledge_entries (turicks-brain)
 *                    3. founder_context  (JSONB business state)
 *                    Results ranked by recency and formatted for Telegram.
 *
 *   record_event   — raw write tool (no interrupt here). The HITL gate is
 *                    applied in the agent-tools.ts wrapper, following the same
 *                    pattern as emailTool / linkedinPostTool.
 *
 * Design notes:
 * - No vector/semantic search — ILIKE keyword + recency is sufficient for v1.
 * - No new npm packages required — uses Drizzle queries already in queries.ts.
 * - search_memory is given to the supervisor directly (not delegated to a dept).
 */

import { tool } from "@langchain/core/tools";
import { TENANT } from "../core/config.js";
import { z } from "zod";
import {
  searchEpisodicMemory,
  searchKnowledgeEntries,
  getFounderContext,
  insertEpisodicEvent,
} from "../db/queries.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:memory" });


// ── search_memory ─────────────────────────────────────────────────────────────

type SearchType = "all" | "episodic" | "knowledge" | "context" | "conversations";

export const searchMemoryTool = tool(
  async ({ query, type = "all" }: { query: string; type?: SearchType }) => {
    log.debug({ query, type }, "search_memory");

    const sections: string[] = [];

    // 1. Episodic memory
    if (type === "all" || type === "episodic") {
      const events = await searchEpisodicMemory(TENANT, query, 5);
      if (events.length > 0) {
        const formatted = events.map((e) => {
          const date = e.occurred_at.toISOString().slice(0, 10);
          const tags = (e.tags ?? []).join(", ");
          const summary = e.summary ? `\n   ${e.summary.slice(0, 200)}` : "";
          return `[${e.event_type}] ${e.title} _(${date})_${summary}${tags ? `\n   Tags: ${tags}` : ""}`;
        });
        sections.push(`**Past Events:**\n${formatted.join("\n\n")}`);
      }
    }

    // 2. Knowledge entries (turicks-brain)
    if (type === "all" || type === "knowledge") {
      const entries = await searchKnowledgeEntries(TENANT, query, 4);
      if (entries.length > 0) {
        const formatted = entries.map((e) => {
          const tags = (e.tags ?? []).join(", ");
          const preview = e.content.slice(0, 300).replace(/\n+/g, " ");
          return `[${("entry_type" in e ? (e as Record<string, unknown>)["entry_type"] ?? "" : "")}] ${e.title}${tags ? `\n   Tags: ${tags}` : ""}\n   ${preview}${e.content.length > 300 ? "…" : ""}`;
        });
        sections.push(`**Knowledge Base:**\n${formatted.join("\n\n")}`);
      }
    }

    // 3. Founder context — text-contains search across keys + values
    if (type === "all" || type === "context") {
      const ctx = await getFounderContext(TENANT);
      if (Object.keys(ctx).length > 0) {
        const lq = query.toLowerCase();
        const matchingLines: string[] = [];
        for (const [key, value] of Object.entries(ctx)) {
          if (key === "last_updated") continue;
          const serialised = Array.isArray(value) ? value.join(", ") : String(value ?? "");
          // Match if query appears in the key name OR in any of the values
          const keyMatches = key.replace(/_/g, " ").includes(lq);
          const valueMatches = serialised.toLowerCase().includes(lq);
          if (keyMatches || valueMatches) {
            matchingLines.push(`• ${key.replace(/_/g, " ")}: ${serialised}`);
          }
        }
        // For context-only type queries with no filter match, show everything
        if (matchingLines.length === 0 && type === "context") {
          for (const [key, value] of Object.entries(ctx)) {
            if (key === "last_updated") continue;
            const serialised = Array.isArray(value) ? value.join(", ") : String(value ?? "");
            matchingLines.push(`• ${key.replace(/_/g, " ")}: ${serialised}`);
          }
        }
        if (matchingLines.length > 0) {
          sections.push(`**Business Context:**\n${matchingLines.join("\n")}`);
        }
      }
    }

    if (sections.length === 0) {
      return `No memory found for "${query}". Try different keywords or use record_event to log something new.`;
    }

    return `Memory results for "${query}":\n\n${sections.join("\n\n")}`;
  },
  {
    name: "search_memory",
    description:
      "Search all memory sources for past conversations, decisions, events, and business context. " +
      "Use when the founder asks 'what did we discuss about X', 'what happened with Y', " +
      "'recall Z', or 'what do we know about W'. Searches episodic events, turicks-brain, " +
      "and the founder's stored business context. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().describe("Keywords to search for, e.g. 'stripe', 'acme deal', 'Tuesday meeting'"),
      type: z
        .enum(["all", "episodic", "knowledge", "context", "conversations"])
        .optional()
        .nullable()
        .default("all")
        .describe(
          "Which memory source to search. " +
            "'all' (default) searches everything. " +
            "'episodic' = past events + decisions. " +
            "'knowledge' = turicks-brain ADRs + brand + case studies. " +
            "'context' = current business state (clients, priorities).",
        ),
    }),
  },
);

// ── record_event (raw write — HITL gate lives in agent-tools.ts wrapper) ─────

/**
 * Raw event-write tool. Called AFTER approval from the agent-tools.ts wrapper.
 * Following the same pattern as emailTool / linkedinPostTool:
 *   agent-tools.ts wrapper → interrupt() approval → this tool executes the write.
 *
 * Tests invoke this tool directly (no interrupt needed, no graph context required).
 */
export const recordEventTool = tool(
  async ({
    title,
    summary,
    tags,
    event_type,
    occurred_at,
  }: {
    title: string;
    summary: string;
    tags: string[];
    event_type: string;
    occurred_at?: string;
  }) => {
    const id = await insertEpisodicEvent({
      tenant_id: TENANT,
      event_type,
      title,
      summary,
      tags,
      thread_id: null,
      source: "telegram",
      occurred_at: occurred_at ? new Date(occurred_at) : new Date(),
    });

    log.info({ id, title, event_type }, "Episodic event recorded");
    return `Event recorded (id: ${id}): "${title}"`;
  },
  {
    name: "record_event",
    description:
      "Record a significant event to episodic memory so it can be recalled later. " +
      "Use for: decisions made ('decided to use Stripe'), outcomes ('closed Acme deal for €12K'), " +
      "tasks completed ('shipped Phase D'), or conversation highlights worth preserving. " +
      "Requires founder approval before writing.",
    schema: z.object({
      title: z
        .string()
        .describe("Short, searchable title — e.g. 'Discussed Stripe integration with Alex'"),
      summary: z
        .string()
        .describe("1–3 sentences describing what happened and why it matters"),
      tags: z
        .array(z.string())
        .describe("Keyword tags for later retrieval — e.g. ['stripe', 'backend', 'alex']"),
      event_type: z
        .enum(["conversation", "decision", "outcome", "task_completed"])
        .describe("Category of event"),
      occurred_at: z
        .string()
        .optional()
        .nullable()
        .describe("ISO 8601 timestamp of when this happened. Defaults to now if omitted."),
    }),
  },
);
