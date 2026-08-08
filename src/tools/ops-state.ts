/**
 * FounderOS — ops_state Tool (Tier 0 Operational State)
 * ====================================================
 * Deterministic read of operational system state:
 *   - scheduled_tasks
 *   - reminders
 *   - hitl_approvals
 *   - action_log
 *   - costs (job_ingest_runs)
 *
 * Always returns `{ count, total, scope, rows }`.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { actionLog, hitlApprovals, jobIngestRuns, reminders, scheduledTasks } from "../db/schema.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const DEFAULT_TENANT = "turicks";

export type OpsScope = "scheduled_tasks" | "reminders" | "hitl_approvals" | "action_log" | "costs";

export interface OpsStateArgs {
  readonly scope: OpsScope;
  readonly status?: string;
  readonly since?: string;
  readonly limit?: number;
}

export async function queryOpsState(
  args: OpsStateArgs,
  tenantId: string = DEFAULT_TENANT,
): Promise<{ count: number; total: number; scope: OpsScope; rows: Record<string, unknown>[] }> {
  const db = getDb();
  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
  const sinceDate = args.since ? new Date(args.since) : undefined;
  const validSince = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : undefined;

  switch (args.scope) {
    case "scheduled_tasks": {
      const [t] = await db.select({ total: sql<number>`count(*)` }).from(scheduledTasks).where(eq(scheduledTasks.tenant_id, tenantId));
      const total = Number(t?.total ?? 0);

      const conds = [eq(scheduledTasks.tenant_id, tenantId)];
      if (args.status) conds.push(eq(scheduledTasks.status, args.status));
      if (validSince) conds.push(gte(scheduledTasks.scheduled_at, validSince));

      const rows = await db
        .select({
          id: scheduledTasks.id,
          prompt: scheduledTasks.prompt,
          chat_id: scheduledTasks.chat_id,
          scheduled_at: scheduledTasks.scheduled_at,
          status: scheduledTasks.status,
          attempts: scheduledTasks.attempts,
          error: scheduledTasks.error,
        })
        .from(scheduledTasks)
        .where(and(...conds))
        .orderBy(desc(scheduledTasks.scheduled_at))
        .limit(limit);

      return { count: rows.length, total, scope: args.scope, rows: rows as unknown as Record<string, unknown>[] };
    }

    case "reminders": {
      const [t] = await db.select({ total: sql<number>`count(*)` }).from(reminders).where(eq(reminders.tenant_id, tenantId));
      const total = Number(t?.total ?? 0);

      const conds = [eq(reminders.tenant_id, tenantId)];
      if (args.status) conds.push(eq(reminders.status, args.status));
      if (validSince) conds.push(gte(reminders.remind_at, validSince));

      const rows = await db
        .select({
          id: reminders.id,
          text: reminders.text,
          remind_at: reminders.remind_at,
          status: reminders.status,
          chat_id: reminders.chat_id,
        })
        .from(reminders)
        .where(and(...conds))
        .orderBy(desc(reminders.remind_at))
        .limit(limit);

      return { count: rows.length, total, scope: args.scope, rows: rows as unknown as Record<string, unknown>[] };
    }

    case "hitl_approvals": {
      const [t] = await db.select({ total: sql<number>`count(*)` }).from(hitlApprovals).where(eq(hitlApprovals.tenant_id, tenantId));
      const total = Number(t?.total ?? 0);

      const conds = [eq(hitlApprovals.tenant_id, tenantId)];
      if (args.status) conds.push(eq(hitlApprovals.status, args.status));
      if (validSince) conds.push(gte(hitlApprovals.created_at, validSince));

      const rows = await db
        .select({
          interrupt_id: hitlApprovals.interrupt_id,
          thread_id: hitlApprovals.thread_id,
          status: hitlApprovals.status,
          created_at: hitlApprovals.created_at,
          resolved_at: hitlApprovals.resolved_at,
        })
        .from(hitlApprovals)
        .where(and(...conds))
        .orderBy(desc(hitlApprovals.created_at))
        .limit(limit);

      return { count: rows.length, total, scope: args.scope, rows: rows as unknown as Record<string, unknown>[] };
    }

    case "action_log": {
      const [t] = await db.select({ total: sql<number>`count(*)` }).from(actionLog).where(eq(actionLog.tenant_id, tenantId));
      const total = Number(t?.total ?? 0);

      const conds = [eq(actionLog.tenant_id, tenantId)];
      if (validSince) conds.push(gte(actionLog.created_at, validSince));

      const rows = await db
        .select({
          id: actionLog.id,
          action: actionLog.action,
          payload: actionLog.payload,
          created_at: actionLog.created_at,
        })
        .from(actionLog)
        .where(and(...conds))
        .orderBy(desc(actionLog.created_at))
        .limit(limit);

      return { count: rows.length, total, scope: args.scope, rows: rows as unknown as Record<string, unknown>[] };
    }

    case "costs": {
      const [t] = await db.select({ total: sql<number>`count(*)` }).from(jobIngestRuns).where(eq(jobIngestRuns.tenant_id, tenantId));
      const total = Number(t?.total ?? 0);

      const conds = [eq(jobIngestRuns.tenant_id, tenantId)];
      if (validSince) conds.push(gte(jobIngestRuns.created_at, validSince));

      const rows = await db
        .select({
          id: jobIngestRuns.id,
          feed: jobIngestRuns.feed,
          track: jobIngestRuns.track,
          requested: jobIngestRuns.requested,
          returned: jobIngestRuns.returned,
          screened: jobIngestRuns.screened,
          passed: jobIngestRuns.passed,
          flagged: jobIngestRuns.flagged,
          rejected: jobIngestRuns.rejected,
          created_at: jobIngestRuns.created_at,
        })
        .from(jobIngestRuns)
        .where(and(...conds))
        .orderBy(desc(jobIngestRuns.created_at))
        .limit(limit);

      return { count: rows.length, total, scope: args.scope, rows: rows as unknown as Record<string, unknown>[] };
    }

    default:
      throw new Error(`Unsupported ops scope: ${String(args.scope)}`);
  }
}

export const opsStateTool: UnifiedTool = {
  name: "ops_state",
  description:
    "Deterministic read of system operational state from Postgres. " +
    "Scopes available: 'scheduled_tasks', 'reminders', 'hitl_approvals', 'action_log', 'costs'. " +
    "Returns { count, total, scope, rows }.",

  input_schema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["scheduled_tasks", "reminders", "hitl_approvals", "action_log", "costs"],
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
    const scope = args["scope"] as OpsScope | undefined;
    if (!scope) {
      return { success: false, error: "ops_state requires a scope argument." };
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
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to query ops state: ${(err as Error).message}`,
      };
    }
  },
};
