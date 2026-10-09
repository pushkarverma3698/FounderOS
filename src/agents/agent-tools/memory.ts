/**
 * Supervisor-level memory tools.
 *   record_event        — WRITE (no approval): commits an event or a saved note to episodic_memory.
 *   recall_conversation — READ: what the founder said in past conversations, by day and/or topic.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { recordEventTool as rawRecordEvent } from "../../tools/memory.js";
import { appTimeZone, systemClock } from "../../core/time.js";
import { earliestConversationTurn, findConversationTurns } from "../../db/conversation-turns.js";
import { recallConversation } from "../../tools/recall-conversation.js";

/**
 * Saving a note or an event to the founder's own memory is a low-risk write he just asked for: it sends nothing and
 * changes nothing outside the log. It is NOT approval-gated (live QA 2026-10-09: "save a note" raised a card).
 */
export const recordEvent = tool(
  async ({ title, summary, tags, event_type, occurred_at }) =>
    rawRecordEvent.invoke({ title, summary, tags, event_type, occurred_at }),
  {
    name: "record_event",
    description: rawRecordEvent.description,
    schema: z.object({
      title: z.string().describe("Short, searchable title"),
      summary: z.string().describe("1–3 sentences describing what happened"),
      tags: z.array(z.string()).describe("Keyword tags for retrieval"),
      event_type: z
        .enum(["note", "conversation", "decision", "outcome", "task_completed"])
        .describe("note = something the founder asked to save; the rest describe what happened"),
      occurred_at: z.string().optional().nullable().describe("ISO 8601 timestamp. Defaults to now."),
    }),
  },
);

/**
 * Read-only, so no HITL. The chat comes from the run's thread id, never from an argument: a guest in an
 * allow-listed group chat can call every non-HITL tool and must not be able to name another chat's log.
 */
export const recallConversationTool = tool(
  async ({ when, about, more }, config) =>
    recallConversation(
      { threadId: String(config?.configurable?.["thread_id"] ?? ""), when, about, more: more ?? undefined },
      {
        reader: { find: findConversationTurns, earliest: earliestConversationTurn },
        clock: systemClock,
        timeZone: appTimeZone(),
      },
    ),
  {
    name: "recall_conversation",
    description:
      "Find what the founder said or asked in PAST conversations with you, older than the current chat. Use for " +
      "'what did I ask you yesterday', 'what did I just ask you', 'what did I say about the visa last week', 'did I mention X'. Pass `when` in the " +
      "founder's own words (just now, an hour ago, earlier today, yesterday, last week, monday, 3 days ago, past 5 days, 2026-09-30) and/or `about` with the " +
      "topic words. Returns his own messages with the day, five at a time; set `more` when he asks to see more. " +
      "Relay the result as written. Not for events you recorded or knowledge-base facts: that is search_memory.",
    schema: z.object({
      when: z.string().optional().nullable().describe("The time, exactly as the founder said it: 'just now', 'an hour ago', 'yesterday', 'last week', 'monday', '3 days ago'"),
      about: z.string().optional().nullable().describe("Topic words to look for in what was said, e.g. 'visa paperwork'"),
      more: z.boolean().optional().nullable().describe("true when the founder asked to see more than the first five"),
    }),
  },
);
