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

export const leverAdapter: AtsAdapter = {
  platformName: "lever",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://api.lever.co/v0/postings/${token}?mode=json`;
  },

  getWireFormat(): "json" {
    return "json";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const postings = Array.isArray(payload) ? payload : [];

    return postings.flatMap((raw) => {
      const job = asRecord(raw);
      if (job === null) return [];

      const externalId = asId(job["id"]);
      const title = asText(job["text"]); // Lever calls the title `text`
      const url = asText(job["hostedUrl"]) || asText(job["applyUrl"]);
      if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

      const categories = asRecord(job["categories"]);

      return [
        {
          board,
          externalId,
          title,
          url,
          location: asText(categories?.["location"]),
          postedAt: parsePostedAt(job["createdAt"]),
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
    return url.endsWith("/apply") ? url : `${url}/apply`;
  },
};
