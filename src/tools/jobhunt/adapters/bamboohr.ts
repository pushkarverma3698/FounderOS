/**
 * BambooHR — the platform whose list endpoint forgot the date
 * ===========================================================
 * 85 IND-sponsor boards, and the only one of the three added on 2026-08-24 that
 * needed a change outside its own file.
 *
 * MEASURED 2026-08-24, live. `/careers/list` returns clean JSON, but its records
 * carry NO publication date — the full field set is `id, jobOpeningName,
 * departmentId, departmentLabel, employmentStatusLabel, employmentType, location,
 * atsLocation, isRemote, locationType`. The date exists only one level down, on
 * `/careers/{id}/detail` as `result.jobOpening.datePosted` ("2025-07-15").
 *
 * That ordering is hostile to the ingest, which filters staleness BEFORE it
 * hydrates bodies precisely so it never pays for a body it is about to discard.
 * Left alone, every BambooHR posting arrives with `postedAt: null`, is counted as
 * `undated`, and is dropped — 85 boards polled forever for nothing, and silently,
 * because "no fresh roles" and "we threw them all away" print identically.
 *
 * `dateOnlyInDetail` is the flag that tells free-ingest.ts to defer only the
 * staleness check for this platform. Track and market filters still run on the
 * list, where title and location ARE present, so ~87% is still discarded before
 * any detail request is made.
 */

import { AtsAdapter, NormalizedJob, decodeJobBody, parsePostedAt } from "./types.js";
import { FreeBoard } from "../free-boards.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * "Orlando, Florida, United States" from whichever of the two location objects
 * is populated.
 *
 * BambooHR carries both `location` and `atsLocation`, and on real boards the
 * first is frequently all-null while the second is complete (verified on a live
 * board: `location` was `{city: null, state: null}` while `atsLocation` held
 * Orlando / Florida / United States). Reading only one of them would drop the
 * market filter's input for an unknown share of postings.
 */
export function bamboohrLocation(record: Record<string, unknown>): string {
  const ats = asRecord(record["atsLocation"]);
  const plain = asRecord(record["location"]);

  const parts = [
    asText(ats?.["city"]) || asText(plain?.["city"]),
    asText(ats?.["state"]) || asText(plain?.["state"]),
    asText(ats?.["country"]),
  ].filter((p) => p.length > 0);

  if (parts.length > 0) return parts.join(", ");
  return record["isRemote"] === true ? "Remote" : "";
}

export const bamboohrAdapter: AtsAdapter = {
  platformName: "bamboohr",

  dateOnlyInDetail: true,

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://${token}.bamboohr.com/careers/list`;
  },

  getWireFormat(): "json" {
    return "json";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const root = asRecord(payload);
    const jobs = Array.isArray(root?.["result"]) ? (root["result"] as unknown[]) : [];

    return jobs.flatMap((raw) => {
      const job = asRecord(raw);
      if (job === null) return [];

      const externalId = asId(job["id"]);
      const title = asText(job["jobOpeningName"]);
      if (externalId.length === 0 || title.length === 0) return [];

      return [
        {
          board,
          externalId,
          title,
          url: `https://${board.token}.bamboohr.com/careers/${externalId}`,
          location: bamboohrLocation(job),
          // Not "unknown" — structurally absent. See the header and
          // `dateOnlyInDetail`; hydration fills this in from the detail payload.
          postedAt: null,
          description: null,
        },
      ];
    });
  },

  getJobUrl(board: FreeBoard, externalId: string): string | null {
    const token = encodeURIComponent(board.token);
    const id = encodeURIComponent(externalId);
    return `https://${token}.bamboohr.com/careers/${id}/detail`;
  },

  extractBody(payload: Record<string, unknown>): string {
    const opening = asRecord(asRecord(payload["result"])?.["jobOpening"]);
    return decodeJobBody(asText(opening?.["description"]));
  },

  /** The detail payload is also where the publication date finally appears. */
  postedAtFromDetail(payload: Record<string, unknown>): Date | null {
    const opening = asRecord(asRecord(payload["result"])?.["jobOpening"]);
    return parsePostedAt(opening?.["datePosted"]);
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    return postingUrl.replace(/\/+$/, "");
  },
};
