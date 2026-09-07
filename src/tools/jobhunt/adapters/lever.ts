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

/**
 * Lever states a body in THREE different places and fills a different one per
 * posting. All three are read, in decreasing order of how clean the text is.
 *
 * MEASURED LIVE, 2026-09-06, on the postings production was losing: extreme-
 * networks served `descriptionPlain: ""` with a full HTML `description`;
 * brillio-2 served both empty with the whole posting in `lists`, Lever's
 * structured requirement blocks. Reading only `descriptionPlain` made every one
 * of them arrive bodyless, and `runFreeIngest` drops a bodyless posting before
 * it is screened — so this single omission was six of the seven postings that
 * survived every other filter, on every sweep, for thirty hours.
 *
 * Returns null, never "", when the employer genuinely posted nothing: that is
 * the one case the `bodyless` drop is actually for.
 */
function leverBody(job: Record<string, unknown>): string | null {
  const plain = asText(job["descriptionPlain"]);
  if (plain.length > 0) return plain;

  const html = decodeJobBody(asText(job["description"]));
  if (html.length > 0) return html;

  const lists = Array.isArray(job["lists"]) ? job["lists"] : [];
  const blocks = lists.flatMap((entry) => {
    const list = asRecord(entry);
    if (list === null) return [];
    // The heading is kept: "Requirements" and "Benefits" are what tell the
    // screening gates which bullets are demands and which are perks.
    const heading = asText(list["text"]);
    const content = decodeJobBody(asText(list["content"]));
    if (content.length === 0) return [];
    return [heading.length > 0 ? `${heading}\n${content}` : content];
  });

  return blocks.length > 0 ? blocks.join("\n\n") : null;
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
          // `descriptionPlain` FIRST, `description` SECOND — not either-or.
          // Lever fills the plain field for most postings and leaves it EMPTY on
          // a real share of them while serving the full body as HTML
          // (measured live on extremenetworks and brillio-2, 2026-09-06).
          // Reading only the plain field made those arrive bodyless, and
          // `runFreeIngest` drops a bodyless posting before it is ever screened
          // — six of the seven postings that survived every other filter in
          // production, silently, on every sweep for thirty hours.
          description: leverBody(job),
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
