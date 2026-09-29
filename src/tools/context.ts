/**
 * FounderOS — Founder Context Tools
 * ===================================
 * Two tools given exclusively to the supervisor:
 *
 *  read_context   — read the founder's current business state (active clients,
 *                   open deals, priorities, next actions)
 *  update_context — merge updates into that state
 *
 * These tools make the system session-persistent: priorities set in one
 * conversation are available in the next without the founder repeating them.
 *
 * Design: stored as a single JSONB blob per tenant in `founder_context`.
 * No LLM cost — pure Postgres read/write.
 */

import { tool } from "@langchain/core/tools";
import { TENANT } from "../core/config.js";
import { z } from "zod";
import { getFounderContext, upsertFounderContext } from "../db/queries.js";
import { renderFounderContext } from "./context-render.js";
import { sanitizeContextUpdates } from "./context-guard.js";
import { withToolErrorBoundary } from "../agents/tool-result.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:context" });


// ── Read context ──────────────────────────────────────────────────────────────

export const readContext = tool(
  async () =>
    withToolErrorBoundary("db", "read founder_context from Postgres", async () =>
      // Each value carries the date it was last confirmed, and one that may be stale
      // says so (context-render.ts). The real clock is read here and nowhere below.
      renderFounderContext(await getFounderContext(TENANT), new Date(), {
        warn: (problem) =>
          log.warn(
            { problem },
            "founder_context dates unreadable — every value is shown as 'date unknown'; the next deploy's seed run rebuilds context_meta",
          ),
      }),
    ),
  {
    name: "read_context",
    description:
      "Read the founder's current business state: active clients, open deals, priorities, next actions. Call this at the start of any session to understand the current situation.",
    schema: z.object({}),
  },
);

// ── Update context ────────────────────────────────────────────────────────────

export const updateContext = tool(
  async ({ updates }) => {
    const { clean, rejected } = sanitizeContextUpdates(updates);

    if (Object.keys(clean).length === 0) {
      // Fail loud (rule #19.5): nothing valid to persist — tell the founder why.
      log.warn({ rejected }, "Founder context update rejected — nothing persisted");
      const why = rejected.map((r) => `${r.key} (${r.reason})`).join("; ");
      return `⚠️ Nothing saved to context. ${
        why || "No recognised business-state fields were provided."
      } Recognised keys: active_clients, open_deals, current_priorities, next_actions, notes (factual state only). The founder sets current_focus and active_projects himself with /focus and /projects.`;
    }

    return withToolErrorBoundary("db", "write founder_context to Postgres", async () => {
      await upsertFounderContext(TENANT, clean, "founder");
      log.info(
        { keys: Object.keys(clean), rejected: rejected.map((r) => r.key) },
        "Founder context updated",
      );
      const keyList = Object.keys(clean).join(", ");
      const skipped =
        rejected.length > 0 ? ` (skipped: ${rejected.map((r) => r.key).join(", ")})` : "";
      return `✅ Context updated: ${keyList}${skipped}`;
    });
  },
  {
    name: "update_context",
    description:
      "Update the founder's business context. Pass an object with the keys to set or overwrite. Recognised keys: active_clients (array of strings), open_deals (array of strings), current_priorities (array of strings), next_actions (array of strings), notes (string). Each key written is dated as confirmed today. Do NOT try to set current_focus or active_projects: the founder sets those himself with /focus and /projects, and this tool refuses them. Use after the founder shares new information about their business state.",
    schema: z.object({
      updates: z.record(z.unknown()).describe(
        "Key-value pairs to merge into context. E.g. { active_clients: ['Acme'], current_priorities: ['Close Acme deal'] }",
      ),
    }),
  },
);
