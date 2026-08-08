/**
 * Deterministic State Tools (Tier 0 — Phase 2)
 *   job_state — deterministic query of job_applications table
 *   ops_state — deterministic query of system operational tables
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { jobStateTool } from "../../tools/job-state.js";
import { opsStateTool } from "../../tools/ops-state.js";

export const jobState = tool(
  async ({ stage, section, source, applied, since, fullDetails, limit }) => {
    const res = await jobStateTool.execute({
      ...(stage ? { stage } : {}),
      ...(section ? { section } : {}),
      ...(source ? { source } : {}),
      ...(typeof applied === "boolean" ? { applied } : {}),
      ...(since ? { since } : {}),
      ...(typeof fullDetails === "boolean" ? { fullDetails } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
    if (!res.success) return `job_state failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "job_state",
    description: jobStateTool.description,
    schema: z.object({
      stage: z.string().optional().nullable().describe("Filter by stage (e.g. 'screened', 'applied', 'rejected')."),
      section: z.string().optional().nullable().describe("Filter by brief section."),
      source: z.string().optional().nullable().describe("Filter by route/source."),
      applied: z.boolean().optional().nullable().describe("Filter applied status."),
      since: z.string().optional().nullable().describe("Filter created_at >= ISO string."),
      fullDetails: z.boolean().optional().nullable().describe("Include all DB columns."),
      limit: z.number().optional().nullable().describe("Max rows to return (default 50, max 200)."),
    }),
  },
);

export const opsState = tool(
  async ({ scope, status, since, limit }) => {
    const res = await opsStateTool.execute({
      scope,
      ...(status ? { status } : {}),
      ...(since ? { since } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
    if (!res.success) return `ops_state failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "ops_state",
    description: opsStateTool.description,
    schema: z.object({
      scope: z.enum(["scheduled_tasks", "reminders", "hitl_approvals", "action_log", "costs"]).describe("Operational scope to query."),
      status: z.string().optional().nullable().describe("Filter by status."),
      since: z.string().optional().nullable().describe("Filter timestamp >= ISO string."),
      limit: z.number().optional().nullable().describe("Max rows to return (default 50, max 200)."),
    }),
  },
);
