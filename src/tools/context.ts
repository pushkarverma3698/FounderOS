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
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:context" });


// ── Read context ──────────────────────────────────────────────────────────────

export const readContext = tool(
  async () => {
    const ctx = await getFounderContext(TENANT);
    if (Object.keys(ctx).length === 0) {
      return "No business context stored yet. Ask the founder to share their current priorities and active clients so you can remember them.";
    }
    const lines: string[] = [];
    for (const [key, value] of Object.entries(ctx)) {
      if (key === "last_updated") continue;
      const val = Array.isArray(value)
        ? value.join(", ") || "(none)"
        : String(value || "(none)");
      lines.push(`• ${key.replace(/_/g, " ")}: ${val}`);
    }
    const updatedAt = ctx["last_updated"] ? `\n\nLast updated: ${ctx["last_updated"]}` : "";
    return `Current business context:\n${lines.join("\n")}${updatedAt}`;
  },
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
    await upsertFounderContext(TENANT, updates);
    log.info({ keys: Object.keys(updates) }, "Founder context updated");
    const keyList = Object.keys(updates).join(", ");
    return `✅ Context updated: ${keyList}`;
  },
  {
    name: "update_context",
    description:
      "Update the founder's business context. Pass an object with the keys to set or overwrite. Recognised keys: active_clients (array of strings), open_deals (array of strings), current_priorities (array of strings), next_actions (array of strings), notes (string). Use after the founder shares new information about their business state.",
    schema: z.object({
      updates: z.record(z.unknown()).describe(
        "Key-value pairs to merge into context. E.g. { active_clients: ['Acme'], current_priorities: ['Close Acme deal'] }",
      ),
    }),
  },
);
