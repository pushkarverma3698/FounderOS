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

import { queryJobState } from "../db/job-queries.js";

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
        observed: {
          kind: "record",
          evidence: `count:${result.count},total:${result.total}`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to query job state: ${(err as Error).message}`,
      };
    }
  },
};
