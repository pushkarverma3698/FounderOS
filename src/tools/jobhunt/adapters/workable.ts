import { AtsAdapter, NormalizedJob, parsePostedAt, decodeJobBody } from "./types.js";
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

export const workableAdapter: AtsAdapter = {
  platformName: "workable",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`;
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

      const externalId = asId(job["shortcode"]);
      const title = asText(job["title"]);
      const url = asText(job["url"]) || asText(job["application_url"]);
      if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

      const location = [asText(job["city"]), asText(job["state"]), asText(job["country"])]
        .filter((part) => part.length > 0)
        .join(", ");

      return [
        {
          board,
          externalId,
          title,
          url,
          location,
          postedAt: parsePostedAt(job["published_on"]),
          description: decodeJobBody(asText(job["description"])) || null,
        },
      ];
    });
  },

  getJobUrl(_board: FreeBoard, _externalId: string): string | null {
    return null;
  },

  extractBody(_payload: Record<string, unknown>): string {
    return "";
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    const url = postingUrl.replace(/\/+$/, "");
    return url.endsWith("/apply") ? url : `${url}/apply`;
  },
};
