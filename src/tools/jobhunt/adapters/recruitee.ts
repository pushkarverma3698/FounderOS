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

export const recruiteeAdapter: AtsAdapter = {
  platformName: "recruitee",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://${token}.recruitee.com/api/offers/`;
  },

  getWireFormat(): "json" {
    return "json";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const root = asRecord(payload);
    const offers = Array.isArray(root?.["offers"]) ? (root["offers"] as unknown[]) : [];

    return offers.flatMap((raw) => {
      const offer = asRecord(raw);
      if (offer === null) return [];
      
      if (offer["status"] !== undefined && offer["status"] !== "published") return [];

      const externalId = asId(offer["id"]);
      const title = asText(offer["title"]);
      const url = asText(offer["careers_url"]) || asText(offer["careers_apply_url"]);
      if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

      const body = [decodeJobBody(asText(offer["description"])), decodeJobBody(asText(offer["requirements"]))]
        .filter((s) => s.length > 0)
        .join("\n\n");

      return [
        {
          board,
          externalId,
          title,
          url,
          location: asText(offer["location"]),
          postedAt: parsePostedAt(offer["published_at"]),
          description: body || null,
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
    return url.endsWith("/c/new") ? url : `${url}/c/new`;
  },
};
