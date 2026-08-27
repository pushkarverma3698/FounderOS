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

export const greenhouseAdapter: AtsAdapter = {
  platformName: "greenhouse",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
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

      const externalId = asId(job["id"]);
      const title = asText(job["title"]);
      const url = asText(job["absolute_url"]);
      if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

      return [
        {
          board,
          externalId,
          title,
          url,
          location: asText(asRecord(job["location"])?.["name"]),
          postedAt: parsePostedAt(job["first_published"]),
          description: null, // Greenhouse does not return descriptions in the list payload
        },
      ];
    });
  },

  getJobUrl(board: FreeBoard, externalId: string): string | null {
    const token = encodeURIComponent(board.token);
    const id = encodeURIComponent(externalId);
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`;
  },

  extractBody(payload: Record<string, unknown>): string {
    // `content` is raw HTML — measured live 2026-08-24 on prod rows:
    // "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;GitLab is…" stored
    // verbatim in job_applications.description. Every other adapter that reads
    // a body off a detail payload (SmartRecruiters, BambooHR, Teamtailor,
    // Recruitee, Workable, Personio) runs it through decodeJobBody; Greenhouse
    // — the largest single platform in the registry at 300 of 1,297 boards —
    // was the one exception, and the tag soup leaked into the Experience
    // gate's "Their words" quotes, CV-overlap keyword matching, and CV
    // tailoring input for every Greenhouse posting the free lane ever hydrated.
    return decodeJobBody(typeof payload["content"] === "string" ? payload["content"] : "");
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    const url = postingUrl.replace(/\/+$/, "");
    return url.endsWith("#app") ? url : `${url}#app`;
  },
};
