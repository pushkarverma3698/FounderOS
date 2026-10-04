/**
 * FounderOS — ops_state Tool (Tier 0 Operational State)
 * ====================================================
 * Deterministic read of operational system state:
 *   - scheduled_tasks
 *   - reminders
 *   - hitl_approvals
 *   - action_log
 *   - costs (job_ingest_runs)
 *   - background_jobs (the VPS daemons and the bot's own routines: files and a registry, no database)
 *
 * Always returns `{ count, total, scope, rows }`.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { actionLog, hitlApprovals, jobIngestRuns, reminders, scheduledTasks } from "../db/schema.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const DEFAULT_TENANT = "turicks";

import { queryOpsState, type OpsScope } from "../db/queries.js";
import { readBackgroundJobs } from "./background-jobs.js";

type Scope = OpsScope | "background_jobs";

export const opsStateTool: UnifiedTool = {
  name: "ops_state",
  description:
    "Deterministic read of system operational state (Postgres; for 'background_jobs', the daemons' own status files). " +
    "Scopes: 'scheduled_tasks', 'reminders', 'hitl_approvals', 'action_log', " +
    "'costs' (money spent on AI calls — dollar totals and per-model breakdown), " +
    "'job_runs' (job sweep throughput — requested/returned/screened/passed counts), " +
    "'background_jobs' (what is running without being asked: automatic PR review, coding dispatch and the built-in routines — " +
    "on/off/paused, the models in use, and what needs attention). " +
    "Use 'costs' for any question about spend, budget or what something cost; " +
    "use 'background_jobs' for 'what is running', 'is review on', 'which model reviews'. " +
    "Returns { count, total, scope, rows }; 'costs' also returns { totals }; 'background_jobs' also returns { summary, attention }.",

  input_schema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["scheduled_tasks", "reminders", "hitl_approvals", "action_log", "costs", "job_runs", "background_jobs"],
        description: "The operational scope to query.",
      },
      status: {
        type: "string",
        description: "Filter by status (e.g. 'scheduled', 'pending', 'approved', 'fired').",
      },
      since: {
        type: "string",
        description: "Filter timestamp >= ISO timestamp string.",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default: 50, max: 200).",
      },
    },
    required: ["scope"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const scope = args["scope"] as Scope | undefined;
    if (!scope) {
      return { success: false, error: "ops_state requires a scope argument." };
    }

    if (scope === "background_jobs") {
      const view = readBackgroundJobs();
      return {
        success: true,
        data: JSON.stringify({ count: view.jobs.length, total: view.jobs.length, scope, summary: view.summary, attention: view.attention, rows: view.jobs }, null, 2),
        observed: { kind: "record", evidence: `scope:${scope},count:${view.jobs.length},attention:${view.attention.length}` },
      };
    }

    try {
      const result = await queryOpsState({
        scope,
        status: args["status"] as string | undefined,
        since: args["since"] as string | undefined,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : undefined,
      });

      return {
        success: true,
        data: JSON.stringify(result, null, 2),
        observed: {
          kind: "record",
          evidence: `scope:${result.scope},count:${result.count},total:${result.total}`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to query ops state: ${(err as Error).message}`,
      };
    }
  },
};
