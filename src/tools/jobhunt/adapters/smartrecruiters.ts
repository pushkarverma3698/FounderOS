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

export const smartrecruitersAdapter: AtsAdapter = {
  platformName: "smartrecruiters",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`;
  },

  getWireFormat(): "json" {
    return "json";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const root = asRecord(payload);
    const postings = Array.isArray(root?.["content"]) ? (root["content"] as unknown[]) : [];

    return postings.flatMap((raw) => {
      const posting = asRecord(raw);
      if (posting === null) return [];

      const externalId = asId(posting["id"]);
      const title = asText(posting["name"]);
      if (externalId.length === 0 || title.length === 0) return [];

      const location = asRecord(posting["location"]);
      return [
        {
          board,
          externalId,
          title,
          url: `https://jobs.smartrecruiters.com/${board.token}/${externalId}`,
          location: asText(location?.["fullLocation"]) || asText(location?.["city"]),
          postedAt: parsePostedAt(posting["releasedDate"]),
          description: null,
        },
      ];
    });
  },

  getJobUrl(board: FreeBoard, externalId: string): string | null {
    const token = encodeURIComponent(board.token);
    const id = encodeURIComponent(externalId);
    return `https://api.smartrecruiters.com/v1/companies/${token}/postings/${id}`;
  },

  extractBody(payload: Record<string, unknown>): string {
    const sections = (payload["jobAd"] as Record<string, unknown> | undefined)?.["sections"];
    if (typeof sections !== "object" || sections === null) return "";
    return Object.values(sections as Record<string, unknown>)
      .map((section) =>
        typeof section === "object" && section !== null
          ? String((section as Record<string, unknown>)["text"] ?? "")
          : "",
      )
      .filter((text) => text.length > 0)
      .map(decodeJobBody)
      .join("\n\n")
      .trim();
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    return postingUrl.replace(/\/+$/, ""); // SmartRecruiters serves the form inline
  },
};
