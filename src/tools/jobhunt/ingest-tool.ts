/**
 * FounderOS — the `ingest_jobs` tool surface
 * ==========================================
 * The single-query path: the founder (or the planner) asks for a sweep with a
 * specific shape — "find me AI roles in Amsterdam from the last week" — and gets
 * a verdict breakdown back.
 *
 * Separated from ingest.ts, which is the unattended DAILY sweep. They share
 * `screenBatch` and nothing else: the sweep guarantees per-track coverage and
 * writes a cost ledger, while this one honours whatever the caller asked for.
 * Keeping them in one file put the file over the 400-line budget and, more to
 * the point, made it easy to read one's guarantees onto the other — this path
 * does NOT split the budget per track, so a broad `titles` array here can still
 * starve a track. That is the caller's choice to make; the sweep's isn't.
 */

import { childLogger } from "../../infra/logger.js";
import { fetchAtsPostings, type AtsQuery } from "./ats-source.js";
import { screenBatch, type IngestResult } from "./ingest.js";
import { formatIngestSummary } from "./ingest-format.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:ingest_jobs" });

/** Fetch → screen → summarise. The whole pipeline in one call. */
export async function runJobIngest(query: AtsQuery = {}): Promise<IngestResult> {
  const fetched = await fetchAtsPostings(query);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const lines = await screenBatch(fetched.postings);
  log.info(
    {
      fetched: fetched.postings.length,
      pass: lines.filter((l) => l.outcome === "pass").length,
      reject: lines.filter((l) => l.outcome === "reject").length,
    },
    "Job ingest complete",
  );
  return { ok: true, summary: { fetched: fetched.postings.length, lines } };
}

export const ingestJobsTool: UnifiedTool = {
  name: "ingest_jobs",
  description:
    "Pull fresh job postings from the ATS feed (~50 platforms: Greenhouse, Lever, " +
    "Workday, Personio, Recruitee…) and screen every one against the hard legal " +
    "gates automatically. This is how postings ENTER the pipeline — use it when the " +
    "founder asks to find, refresh, or sweep for new jobs. Returns a verdict " +
    "breakdown, not a list of links. Read-mostly, no approval needed, no model spend.",
  input_schema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Postings to pull (minimum 10, which is also the daily budget).",
      },
      time_range: {
        type: "string",
        description: "How far back to look: 1h, 24h, 7d, or 6m. Defaults to 24h.",
      },
      titles: {
        type: "array",
        description:
          "Array of title phrases to search, e.g. ['AI Engineer:*']. ':*' is a prefix wildcard. " +
          "Omit to use the campaign's default target roles.",
      },
      locations: {
        type: "array",
        description:
          "Array of exact 'City, Region, Country' phrases or a bare country, English names only " +
          "(e.g. 'Amsterdam, North Holland, Netherlands'). Defaults to the Netherlands.",
      },
      organizations: {
        type: "array",
        description:
          "Array of employer names to restrict to — this is how the IND recognised-sponsor " +
          "register is used as a target list rather than only as a filter.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const timeRange = args["time_range"];
    const query: AtsQuery = {
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
      ...(timeRange === "1h" || timeRange === "24h" || timeRange === "7d" || timeRange === "6m"
        ? { timeRange }
        : {}),
      ...(Array.isArray(args["titles"]) ? { titles: args["titles"] as string[] } : {}),
      ...(Array.isArray(args["locations"]) ? { locations: args["locations"] as string[] } : {}),
      ...(Array.isArray(args["organizations"])
        ? { organizations: args["organizations"] as string[] }
        : {}),
    };

    const result = await runJobIngest(query);
    if (!result.ok) {
      return {
        success: false,
        error:
          `Job ingest failed: ${result.error}\n` +
          "No postings were screened. Nothing was recorded — there is deliberately no " +
          "fallback to web search, because a search snippet through the salary gate " +
          "produces a confident verdict from evidence that was never fetched.",
      };
    }
    return { success: true, data: formatIngestSummary(result.summary) };
  },
};
