/**
 * Supervisor-level memory tool.
 *   record_event — WRITE (HITL-gated): commits an event to episodic_memory.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { recordEventTool as rawRecordEvent } from "../../tools/memory.js";
import { hitlGate } from "./hitl.js";
import { registerTool } from "../registry.js";

/**
 * HITL wrapper around the raw recordEventTool. The approval card lets the founder
 * review the event before it's committed to episodic_memory.
 */
export const recordEvent = registerTool(
  tool(
    async ({ title, summary, tags, event_type, occurred_at }) => {
      const tagsStr = tags.join(", ") || "(none)";
      const rejected = hitlGate({
        action: "record_event",
        title: `📝 Record event: "${title}"?`,
        summary: `Type: ${event_type} | Tags: ${tagsStr}`,
        preview: summary,
        args: { title, summary, tags, event_type, occurred_at },
      });
      if (rejected) return rejected;

      return rawRecordEvent.invoke({ title, summary, tags, event_type, occurred_at });
    },
    {
      name: "record_event",
      description: rawRecordEvent.description,
      schema: z.object({
        title: z.string().describe("Short, searchable title"),
        summary: z.string().describe("1–3 sentences describing what happened"),
        tags: z.array(z.string()).describe("Keyword tags for retrieval"),
        event_type: z
          .enum(["conversation", "decision", "outcome", "task_completed"])
          .describe("Category of event"),
        occurred_at: z.string().optional().nullable().describe("ISO 8601 timestamp. Defaults to now."),
      }),
    },
  ),
  {
    isSupervisor: true,
    hitlGated: true,
    promptDescription: "commit an event to episodic memory (requires approval)",
  },
);
