/**
 * FounderOS — job_state Tool (Tier 0 Deterministic State)
 * =======================================================
 * Deterministic read of `job_applications` table.
 * Answers "what state am I currently in" for captured jobs, applied roles,
 * waiting applications, and rejected postings.
 *
 * Always returns `{ count, total, rows }` where `total` is the unfiltered total
 * count in `job_applications` for the tenant — across every candidate, always,
 * regardless of `profile`.
 *
 * `count`/`rows` default to the founder's own queue when `profile` is omitted
 * (never "every candidate mixed together") — until 2026-09-07 this tool had no
 * profile filter at all, so a second registered candidate's rows were
 * indistinguishable from the founder's own in every reply. See
 * profile-config.ts's DEFAULT_PROFILE_ID doc for the history of this failure
 * mode; this tool was the one caller that never got fixed with the rest.
 */

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { jobApplications, type JobApplication } from "../db/schema.js";
import type { UnifiedTool, ToolResult } from "./index.js";

import { queryJobState, ALL_PROFILES } from "../db/job-queries.js";
import { listProfiles, resolveProfileToken } from "./jobhunt/profile-config.js";

/** "all" / "both" / "everyone" — the founder or the LLM asking for every candidate at once. */
const ALL_PROFILES_TOKENS = new Set(["all", "both", "everyone", "everybody"]);

/**
 * `undefined` = no `profile` arg given → `queryJobState` defaults to
 * DEFAULT_PROFILE_ID, same as every other jobhunt query (profileCondition).
 * A string that does not resolve is a LOUD miss, not a silent cross-candidate
 * query: this tool mixed both profiles' rows for every caller until
 * 2026-09-07, which is exactly the bug being fixed here.
 */
function resolveProfileFilter(raw: string | undefined): { profileId?: string | typeof ALL_PROFILES; error?: string } {
  if (raw === undefined) return {};
  const normalized = raw.trim().toLowerCase();
  if (ALL_PROFILES_TOKENS.has(normalized)) return { profileId: ALL_PROFILES };
  const resolved = resolveProfileToken(raw);
  if (resolved) return { profileId: resolved };
  const known = listProfiles().map((p) => p.id).join(", ");
  return { error: `Unknown profile "${raw}". Known profiles: ${known}, or "all".` };
}

export const jobStateTool: UnifiedTool = {
  name: "job_state",
  description:
    "Deterministic read of captured job applications from Postgres. " +
    "Use this tool for state questions ('show all jobs', 'how many jobs in pipeline', 'which ones applied to', 'what was rejected'). " +
    "Do NOT use job_brief for factual listing questions. Returns { count, total, rows }. " +
    "`total` is ALWAYS the unfiltered count across every registered candidate, never just the " +
    "one `profile` filtered to — never report `total` as one candidate's number.",

  input_schema: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description:
          "REQUIRED whenever the question names a specific candidate (e.g. 'Tashi', 'my wife', " +
          "'Pushkar'). Accepts a profile id (e.g. 'wife-nl-finance'), a first name, or 'all' for " +
          "every candidate at once. Omitting this when more than one profile is registered " +
          "defaults to the founder's own queue — it does NOT mean 'everyone'.",
      },
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
      const profile = resolveProfileFilter(args["profile"] as string | undefined);
      if (profile.error) {
        return { success: false, error: profile.error };
      }

      const result = await queryJobState({
        profileId: profile.profileId,
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
