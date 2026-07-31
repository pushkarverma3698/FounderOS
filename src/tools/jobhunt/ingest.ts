/**
 * FounderOS — ingest_jobs tool + daily sweep
 * ==========================================
 * Fetch postings from the ATS feed and run every one through the SAME gates the
 * founder's manual paste goes through (`screenPosting`). No second
 * implementation of any gate lives here — that drift would be invisible,
 * because both paths would keep returning confident verdicts.
 *
 * Zero model spend: fetch is HTTP, gates are pure code, the summary is a
 * template. The daily sweep can therefore run unattended without touching the
 * LLM budget at all.
 *
 * A low number is a FINDING, not a fault. Netherlands + recognised sponsor +
 * 2–5 years + AI/backend is a narrow slice, and the count this produces is the
 * first honest measurement of a market the campaign doc has been estimating.
 */

import { childLogger } from "../../infra/logger.js";
import { fetchAtsPostings, type AtsQuery, type RawPosting } from "./ats-source.js";
import { screenPosting } from "./screen.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:ingest_jobs" });

/** Provenance stamped on every row this path creates. */
export const INGEST_SOURCE = "ats-ingest";

export interface IngestLine {
  readonly company: string;
  readonly title: string;
  readonly outcome: "pass" | "flag" | "reject" | "duplicate" | "error";
  readonly detail: string;
}

export interface IngestSummary {
  readonly fetched: number;
  readonly lines: readonly IngestLine[];
}

export type IngestResult =
  | { readonly ok: true; readonly summary: IngestSummary }
  | { readonly ok: false; readonly error: string };

/**
 * Screen a batch of already-fetched postings.
 *
 * Split out from the fetch so the batch behaviour is unit-testable without a
 * network call, and so a caller with postings from anywhere else can reuse it.
 *
 * One posting that blows up does NOT abort the batch. Losing nine good
 * screenings because the tenth had a malformed body would be the pipeline
 * failing at exactly the moment it is supposed to be unattended.
 */
export async function screenBatch(postings: readonly RawPosting[]): Promise<IngestLine[]> {
  const lines: IngestLine[] = [];

  for (const posting of postings) {
    try {
      const outcome = await screenPosting({
        company: posting.company,
        title: posting.title,
        description: posting.description,
        ...(posting.url ? { url: posting.url } : {}),
        ...(posting.postedAt ? { postedAt: posting.postedAt } : {}),
        source: INGEST_SOURCE,
      });

      if (outcome.kind === "error") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "error",
          detail: outcome.message,
        });
      } else if (outcome.kind === "duplicate") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "duplicate",
          detail: `already in pipeline at stage "${outcome.stage}"`,
        });
      } else {
        lines.push({
          company: outcome.company,
          title: outcome.title,
          outcome: outcome.verdict.status,
          detail: outcome.verdict.reasons[0] ?? outcome.route,
        });
      }
    } catch (err) {
      lines.push({
        company: posting.company,
        title: posting.title,
        outcome: "error",
        detail: (err as Error).message,
      });
    }
  }

  return lines;
}

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

// ── Formatting (pure) ─────────────────────────────────────────────────────────

const GROUP_ORDER: ReadonlyArray<IngestLine["outcome"]> = [
  "pass",
  "flag",
  "reject",
  "duplicate",
  "error",
];

const GROUP_LABEL: Record<IngestLine["outcome"], string> = {
  pass: "PASS — clears every hard gate, safe to draft",
  flag: "NEEDS A HUMAN CHECK — one gate couldn't be settled from the posting",
  reject: "REJECT — a legal bar, not a preference",
  duplicate: "SKIPPED — already in the pipeline",
  error: "FAILED TO SCREEN",
};

export function formatIngestSummary(summary: IngestSummary): string {
  if (summary.fetched === 0) {
    return (
      "INGEST — 0 postings.\n\n" +
      "The feed returned nothing for this query. That is a measurement, not " +
      "necessarily a fault: Netherlands + 2–5 years + AI/backend in the last 24h " +
      "is a narrow slice. If it stays at 0 for several days, widen the titles or " +
      "the time range rather than assuming the sweep is broken."
    );
  }

  const counts = GROUP_ORDER.map(
    (g) => `${g}: ${summary.lines.filter((l) => l.outcome === g).length}`,
  ).join(" · ");

  const sections = GROUP_ORDER.flatMap((group) => {
    const rows = summary.lines.filter((l) => l.outcome === group);
    if (rows.length === 0) return [];
    const body = rows
      .map((r) => `  · ${r.company} — ${r.title}\n      ${r.detail}`)
      .join("\n");
    return [`${GROUP_LABEL[group]} (${rows.length})\n${body}`];
  });

  return `INGEST — ${summary.fetched} postings screened.\n${counts}\n\n${sections.join("\n\n")}`;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

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
