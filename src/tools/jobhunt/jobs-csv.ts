/**
 * FounderOS — `export_jobs_csv`: the shortlist as a file, built by code
 * ====================================================================
 * WHY THIS TOOL EXISTS. Until 2026-09-08 there was no CSV export tool at all.
 * The jobhunt prompt's step 4 read: call `job_state`, then "call write_artifact
 * with … content: <the CSV formatted string>". So the file the founder opened
 * was model prose — every company, every title and every apply link
 * re-typed from JSON the model had read earlier, with nothing in the loop
 * comparing the two. Copying a URL correctly was a matter of attention.
 *
 * It failed twice in one evening (2026-09-07):
 *   21:54  tashi_goyal_screened_jobs.csv — the entire "Apply/Source URL"
 *          column was the literal string "N/A", while the database held a full
 *          Workday URL for every one of those employers.
 *   21:56  job_applications_export.csv — sent after the founder said the links
 *          were dead; most URLs truncated to a bare domain
 *          ("https://careers.abb", which does not resolve). The reply claimed
 *          it had been regenerated "with direct application URLs included".
 *
 * The receipt could not catch it. `write_artifact` verifies that a file exists
 * and how many bytes it is — never that the bytes are the rows. A file of
 * forty fabricated links and a file of forty real ones stat identically.
 *
 * WHAT CHANGES. The model chooses the FILTER; it never authors a CELL. Rows
 * come from `queryJobState` (the same query `job_state` answers with) and are
 * serialised by `sheet-rows.ts` + `csv-export.ts`, both already pure and
 * unit-tested. The receipt carries `rows:N,with_url:M`, so "URLs included" is a
 * claim the envelope can contradict.
 */

import { queryJobState, ALL_PROFILES, type ProfileScope } from "../../db/job-queries.js";
import type { JobApplication } from "../../db/schema.js";
import { writeArtifactFile } from "../artifact.js";
import type { UnifiedTool, ToolResult } from "../index.js";
import { buildQueueTab, buildLogTab } from "./sheet-rows.js";
import { toCsv } from "./csv-export.js";
import { listProfiles, resolveProfileScope } from "./profile-config.js";

/** Which table the file holds. Mirrors `/csv` so the two never disagree. */
export type JobsCsvKind = "queue" | "log";

/** `all` and friends — an explicit cross-candidate export, never the default. */

function resolveProfileFilter(raw: string | undefined): { profileId?: ProfileScope; error?: string } {
  // One implementation, in profile-config.ts — this file and job-state.ts
  // carried byte-identical copies until 2026-09-08.
  return resolveProfileScope(raw, ALL_PROFILES);
}

/**
 * `queue` is the ranked shortlist (needs `brief_rank`); `log` is everything
 * screened, rejects included. `log` is the safe default for an open-ended
 * "export the jobs" — a queue export silently drops every row the last ranking
 * did not pin, which reads as missing data rather than as a filter.
 */
function resolveKind(raw: unknown): JobsCsvKind {
  return String(raw ?? "").trim().toLowerCase() === "queue" ? "queue" : "log";
}

/** How many rows carry a link. The number the receipt reports and the reply may not overstate. */
export function countRowsWithUrl(rows: readonly JobApplication[]): number {
  return rows.filter((r) => typeof r.url === "string" && r.url.trim().length > 0).length;
}

/**
 * `UnifiedTool` plus the thread id, which decides which artifacts directory the
 * file lands in. Kept as a local widening rather than pushed into the shared
 * `UnifiedTool` contract: exactly one tool needs it, and every other
 * implementation would have to grow a parameter it ignores.
 */
export interface JobsCsvTool extends Omit<UnifiedTool, "execute"> {
  execute(args: Record<string, unknown>, ctx?: { threadId?: string }): Promise<ToolResult>;
}

export const exportJobsCsvTool: JobsCsvTool = {
  name: "export_jobs_csv",
  description:
    "Write the captured job rows to a CSV file, built in code straight from Postgres. " +
    "THE ONLY way to produce a jobs CSV — never compose CSV text yourself and never pass it to " +
    "write_artifact: the apply links must be copied from the database, not retyped. " +
    "Takes the same filters as job_state (profile, kind, stage, section, track, applied, since). " +
    "Returns { path, rows, rowsWithUrl } — pass `path` to deliver_artifact to send it.",

  input_schema: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description:
          "REQUIRED when the request names a candidate ('Tashi', 'my wife'). A profile id, a " +
          "first name, or 'all'. Omitting it exports the founder's own queue.",
      },
      kind: {
        type: "string",
        enum: ["queue", "log"],
        description:
          "'log' (default) = everything screened, rejects included, with the apply link. " +
          "'queue' = the ranked shortlist only, numbered as /draft takes it.",
      },
      stage: { type: "string", description: "Filter by stage (e.g. 'screened', 'applied', 'rejected')." },
      section: { type: "string", description: "Brief priority bucket: do_today | stretch | ask | standing." },
      track: { type: "string", description: "Role classification (e.g. 'accountant', 'fpa', 'ai')." },
      applied: { type: "boolean", description: "true = applied only, false = not yet applied." },
      since: { type: "string", description: "Only rows discovered on/after this ISO timestamp." },
      limit: { type: "number", description: "Max rows (default 200, the table maximum)." },
      id: { type: "string", description: "Artifact filename stem (default: jobs_export)." },
    },
  },

  async execute(args: Record<string, unknown>, ctx?: { threadId?: string }): Promise<ToolResult> {
    const profile = resolveProfileFilter(args["profile"] as string | undefined);
    if (profile.error) return { success: false, error: profile.error };

    const kind = resolveKind(args["kind"]);

    try {
      const { rows, total } = await queryJobState({
        profileId: profile.profileId,
        stage: args["stage"] as string | undefined,
        section: args["section"] as string | undefined,
        track: args["track"] as string | undefined,
        ...(typeof args["applied"] === "boolean" ? { applied: args["applied"] as boolean } : {}),
        since: args["since"] as string | undefined,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : 200,
        // Not optional: the curated projection has no url/posted_at/liveness,
        // which are the columns the file is FOR.
        fullDetails: true,
      });

      const full = rows as JobApplication[];
      if (full.length === 0) {
        // Loud, and never a file. An empty CSV delivered as a success is the
        // shape of the failure this tool replaces.
        return {
          success: false,
          error:
            `No rows matched — the CSV would be 0 rows, so nothing was written. ` +
            `${total} row(s) exist in total; widen or drop a filter (profile/stage/section/track/since).`,
        };
      }

      const now = new Date();
      const table = kind === "queue" ? buildQueueTab(full, now) : buildLogTab(full, now);
      const rowsWithUrl = countRowsWithUrl(full);

      const written = await writeArtifactFile(
        {
          id: (args["id"] as string | undefined)?.trim() || "jobs_export",
          content: toCsv(table),
          format: "csv",
        },
        ctx?.threadId ?? "default",
      );

      return {
        success: true,
        data: JSON.stringify(
          { path: written.path, bytes: written.bytes, kind, rows: full.length, rowsWithUrl },
          null,
          2,
        ),
        observed: {
          kind: "file",
          // The counts ride on the receipt so a reply claiming "with direct
          // application URLs included" can be checked against what was written.
          evidence: `${written.path}:${written.bytes}:rows:${full.length}:with_url:${rowsWithUrl}`,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to export jobs CSV: ${(err as Error).message}` };
    }
  },
};
