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
import { sanitizeContextUpdates } from "./context-guard.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:context" });


// ── Read context ──────────────────────────────────────────────────────────────

export const readContext = tool(
  async () => {
    const ctx = await getFounderContext(TENANT);
    const lines: string[] = [];
    for (const [key, value] of Object.entries(ctx)) {
      if (key === "last_updated") continue;
      const val = Array.isArray(value)
        ? value.join(", ") || "(none)"
        : String(value || "(none)");
      if (Array.isArray(value) && value.length === 0) continue; // skip empty fields
      lines.push(`• ${key.replace(/_/g, " ")}: ${val}`);
    }
    // Only `last_updated` (or nothing) means there is no real context to surface.
    if (lines.length === 0) {
      return "No business context stored yet. Ask the founder to share their current priorities and active clients so you can remember them.";
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
    const { clean, rejected } = sanitizeContextUpdates(updates);

    if (Object.keys(clean).length === 0) {
      // Fail loud (rule #19.5): nothing valid to persist — tell the founder why.
      log.warn({ rejected }, "Founder context update rejected — nothing persisted");
      const why = rejected.map((r) => `${r.key} (${r.reason})`).join("; ");
      return `⚠️ Nothing saved to context. ${
        why || "No recognised business-state fields were provided."
      } Recognised keys: active_clients, open_deals, current_priorities, next_actions, notes (factual state only).`;
    }

    await upsertFounderContext(TENANT, clean);
    log.info(
      { keys: Object.keys(clean), rejected: rejected.map((r) => r.key) },
      "Founder context updated",
    );
    const keyList = Object.keys(clean).join(", ");
    const skipped =
      rejected.length > 0
        ? ` (skipped: ${rejected.map((r) => r.key).join(", ")})`
        : "";
    return `✅ Context updated: ${keyList}${skipped}`;
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
