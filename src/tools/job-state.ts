/**
 * FounderOS — job_state Tool (Tier 0 Deterministic State)
 * =======================================================
 * Deterministic read of `job_applications` table.
 * Answers "what state am I currently in" for captured jobs, applied roles,
 * waiting applications, and rejected postings.
 *
 * Always returns `{ count, total, rows }` where `total` is the unfiltered total
 * count in `job_applications` for the tenant.
 */

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { jobApplications, type JobApplication } from "../db/schema.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const DEFAULT_TENANT = "turicks";

export interface JobStateArgs {
  readonly stage?: string;
  readonly section?: string;
  readonly source?: string;
  readonly applied?: boolean;
  readonly since?: string;
  readonly fullDetails?: boolean;
  readonly limit?: number;
}

export type CuratedJobRow = Pick<
  JobApplication,
  "id" | "company" | "title" | "stage" | "salary_status" | "applied_at" | "created_at" | "url" | "track"
> & { readonly gate_json?: unknown };

export async function queryJobState(
  args: JobStateArgs = {},
  tenantId: string = DEFAULT_TENANT,
): Promise<{ count: number; total: number; rows: Array<CuratedJobRow | JobApplication> }> {
  const db = getDb();

  // Total count (unfiltered)
  const [totalRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(jobApplications)
    .where(eq(jobApplications.tenant_id, tenantId));
  const total = Number(totalRow?.total ?? 0);

  const conditions = [eq(jobApplications.tenant_id, tenantId)];

  if (args.stage) {
    conditions.push(eq(jobApplications.stage, args.stage));
  }
  if (args.section) {
    conditions.push(eq(jobApplications.brief_section, args.section));
  }
  if (args.source) {
    conditions.push(eq(jobApplications.route, args.source));
  }
  if (args.applied === true) {
    conditions.push(isNotNull(jobApplications.applied_at));
  } else if (args.applied === false) {
    conditions.push(isNull(jobApplications.applied_at));
  }
  if (args.since) {
    const sinceDate = new Date(args.since);
    if (!isNaN(sinceDate.getTime())) {
      conditions.push(gte(jobApplications.created_at, sinceDate));
    }
  }

  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);

  const rows = await db
    .select({
      id: jobApplications.id,
      company: jobApplications.company,
      title: jobApplications.title,
      stage: jobApplications.stage,
      salary_status: jobApplications.salary_status,
      applied_at: jobApplications.applied_at,
      created_at: jobApplications.created_at,
      url: jobApplications.url,
      track: jobApplications.track,
      gate_json: jobApplications.gate_json,
    })
    .from(jobApplications)
    .where(and(...conditions))
    .orderBy(desc(jobApplications.created_at))
    .limit(limit);

  return {
    count: rows.length,
    total,
    rows,
  };
}

export const jobStateTool: UnifiedTool = {
  name: "job_state",
  description:
    "Deterministic read of captured job applications from Postgres. " +
    "Use this tool for state questions ('show all jobs', 'how many jobs in pipeline', 'which ones applied to', 'what was rejected'). " +
    "Do NOT use job_brief for factual listing questions. Returns { count, total, rows }.",

  input_schema: {
    type: "object",
    properties: {
      stage: {
        type: "string",
        description: "Filter by stage (e.g. 'screened', 'drafted', 'awaiting_approval', 'applied', 'replied', 'rejected').",
      },
      section: {
        type: "string",
        description: "Filter by brief section (e.g. 'DO TODAY', 'STRETCH', 'ONE QUESTION AWAY').",
      },
      source: {
        type: "string",
        description: "Filter by route/source (e.g. 'hsm', 'free-ats').",
      },
      applied: {
        type: "boolean",
        description: "Filter applied status: true for applied_at != null, false for unapplied.",
      },
      since: {
        type: "string",
        description: "Filter created_at >= ISO timestamp string.",
      },
      fullDetails: {
        type: "boolean",
        description: "Set true to include all 40 DB columns instead of curated summary fields.",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default: 50, max: 200).",
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await queryJobState({
        stage: args["stage"] as string | undefined,
        section: args["section"] as string | undefined,
        source: args["source"] as string | undefined,
        applied: typeof args["applied"] === "boolean" ? (args["applied"] as boolean) : undefined,
        since: args["since"] as string | undefined,
        fullDetails: typeof args["fullDetails"] === "boolean" ? (args["fullDetails"] as boolean) : undefined,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : undefined,
      });

      return {
        success: true,
        data: JSON.stringify(result, null, 2),
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to query job state: ${(err as Error).message}`,
      };
    }
  },
};
