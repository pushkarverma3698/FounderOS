/**
 * list_pending_signals — read-only view of unconsumed dept_signals rows.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TENANT } from "../../core/config.js";
import { listPendingDeptEvents } from "../../db/queries.js";

export const listPendingSignals = tool(
  async ({ to_dept }) => {
    const rows = await listPendingDeptEvents(TENANT, to_dept ?? undefined);
    if (rows.length === 0) {
      return to_dept
        ? `No pending signals for department "${to_dept}".`
        : "No pending cross-department signals.";
    }
    const lines = rows.map((r) => {
      const payload = JSON.stringify(r.payload ?? {});
      return `• ${r.event_type} (${r.from_dept} → ${r.to_dept ?? "broadcast"}) — ${payload}`;
    });
    return `Pending signals (${rows.length}):\n${lines.join("\n")}`;
  },
  {
    name: "list_pending_signals",
    description:
      "List unconsumed cross-department signals (e.g. qualified leads, approved proposals). Read-only — does not consume or act on them.",
    schema: z.object({
      to_dept: z
        .string()
        .optional()
        .nullable()
        .describe("Filter by target department (optional)."),
    }),
  },
);
