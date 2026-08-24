import { AtsAdapter, NormalizedJob, parsePostedAt } from "./types.js";
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

export const ashbyAdapter: AtsAdapter = {
  platformName: "ashby",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  },

  getWireFormat(): "json" {
    return "json";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const root = asRecord(payload);
    const jobs = Array.isArray(root?.["jobs"]) ? (root["jobs"] as unknown[]) : [];

    return jobs.flatMap((raw) => {
      const job = asRecord(raw);
      if (job === null) return [];

      if (job["isListed"] === false) return [];

      const externalId = asId(job["id"]);
      const title = asText(job["title"]);
      const url = asText(job["jobUrl"]) || asText(job["applyUrl"]);
      if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

      return [
        {
          board,
          externalId,
          title,
          url,
          location: asText(job["location"]),
          postedAt: parsePostedAt(job["publishedAt"]),
          description: asText(job["descriptionPlain"]) || null,
        },
      ];
    });
  },

  getJobUrl(_board: FreeBoard, _externalId: string): string | null {
    return null; // Body is inlined
  },

  extractBody(_payload: Record<string, unknown>): string {
    return ""; // Inlined
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    const url = postingUrl.replace(/\/+$/, "");
    return url.endsWith("/application") ? url : `${url}/application`;
  },
};
