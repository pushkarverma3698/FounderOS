/**
 * Workflow catalog tool (admin worker).
 *   list_workflows — read-only: the founder's most-run scripts/workflows, so a
 *   proven job can be found and re-run tomorrow instead of re-derived.
 *
 * Backed by agents.saved_workflows (recordWorkflowRun writes it best-effort
 * after vps_run / claude_code succeed). Read-only — no approval needed.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TENANT } from "../../core/config.js";
import { topWorkflows } from "../../db/queries.js";
import { formatTimestamp } from "../../infra/timestamp.js";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

export const listWorkflows = tool(
  async ({ limit }) => {
    const cap = Math.min(Math.max(1, Math.round(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const rows = await topWorkflows(TENANT, cap);
    if (rows.length === 0) {
      return "🗂️ No workflows catalogued yet — they're recorded automatically after a vps_run or claude_code job succeeds.";
    }
    const lines = rows.map((w, i) => {
      const runs = `${w.run_count}× run`;
      const last = `last ${formatTimestamp(w.last_used_at)}`;
      const where = w.s3_keys.length ? `${w.s3_keys.length} S3 artifact(s)` : "no S3 artifacts";
      return `${i + 1}. ${w.slug} — ${w.tool} · ${runs} · ${last} · ${where}`;
    });
    return ["🗂️ Most-used workflows (most-run first):", ...lines].join("\n");
  },
  {
    name: "list_workflows",
    description:
      "List the founder's most-used scripts/workflows (from the saved-workflow catalog), most-run first, " +
      "with how many times each ran, when it last ran, and whether its outputs are in S3. " +
      "Use to find a proven job to re-run. Read-only — no approval needed.",
    schema: z.object({
      limit: z.number().optional().nullable().describe(`How many to show (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
    }),
  },
);
