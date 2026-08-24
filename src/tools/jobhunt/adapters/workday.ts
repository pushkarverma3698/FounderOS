/**
 * Workday — the largest single block of unreached IND sponsors
 * ============================================================
 * Joining the recognised-sponsor register to the published Workday corpus found
 * 193 sponsor boards we have never polled, against 85 on BambooHR and 23 on
 * Teamtailor. It is the reason this batch exists.
 *
 * Workday is unlike every platform before it in three ways, each measured live
 * on 2026-08-24 rather than assumed:
 *
 *  1. The list endpoint is a POST with a JSON body, not a GET.
 *  2. `limit` is capped at 20. Asking for 50 or 100 returns ZERO postings — not
 *     an error, not a truncated page, an empty one. A single greedy request
 *     would therefore read a big board as an empty board.
 *  3. `postedOn` is English prose — "Posted 21 Days Ago" — not a timestamp.
 *
 * Ordering is newest-first (measured: 21 → 24 → 27 → 30+ days), which is what
 * makes a bounded page count honest: MAX_PAGES pages is "the freshest 100
 * postings", not "an arbitrary slice".
 */

import { AtsAdapter, BoardPaging, BoardRequest, NormalizedJob, decodeJobBody } from "./types.js";
import { FreeBoard } from "../free-boards.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A Workday board's coordinates, packed into the registry's single token column.
 *
 * The datacenter (`wd5`) is NOT derivable from the tenant — the corpus carries at
 * least ten distinct values (wd1 723×, wd3 495×, wd5 440×, wd12, wd103, wd501 …)
 * and only its `url` column knows which. Packing all three into the token keeps
 * `free-ats-boards.csv` at four columns and `FreeBoard.token` opaque, so nothing
 * upstream of this file learns that Workday is shaped differently.
 */
export interface WorkdayCoords {
  readonly tenant: string;
  readonly datacenter: string;
  readonly site: string;
}

export function parseWorkdayToken(token: string): WorkdayCoords | null {
  const parts = token.split("/").map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [tenant, datacenter, site] = parts as [string, string, string];
  if (tenant.length === 0 || site.length === 0) return null;
  if (!/^wd\d+$/.test(datacenter)) return null;
  return { tenant, datacenter, site };
}

/** Derive the registry token from a corpus row's `url` column. */
export function workdayTokenFromUrl(url: string): string | null {
  const match = /^https:\/\/([^./]+)\.(wd\d+)\.myworkdayjobs\.com\/([^/?#]+)/.exec(url.trim());
  if (!match) return null;
  return `${match[1]}/${match[2]}/${match[3]}`;
}

function coordsOrThrow(board: FreeBoard): WorkdayCoords {
  const coords = parseWorkdayToken(board.token);
  if (coords === null) {
    throw new Error(
      `Workday token "${board.token}" is not "<tenant>/<wdN>/<site>". ` +
        `Re-run pnpm jobhunt:import-boards to rewrite it from the corpus URL.`,
    );
  }
  return coords;
}

const origin = (c: WorkdayCoords): string => `https://${c.tenant}.${c.datacenter}.myworkdayjobs.com`;
const cxs = (c: WorkdayCoords): string => `${origin(c)}/wday/cxs/${c.tenant}/${c.site}`;

/**
 * How "Posted 21 Days Ago" becomes a date, and when it deliberately does not.
 *
 * "30+ Days Ago" returns NULL rather than now-30d. It is a bucket, not a
 * measurement: the posting may be 31 days old or 500, and the two are not the
 * same fact. Writing the optimistic end of an open range would place months-old
 * roles at the top of a queue whose entire promise is freshness.
 *
 * Everything unrecognised also returns null. `postedAt: new Date()` on an
 * unparseable date is the exact defect that made `jobindex-source.ts` unusable —
 * it manufactures a fresh posting out of an unknown one, and it fails silently
 * because a fabricated date looks like a good date. Null is honest, and the
 * ingest funnel already counts it as `undated`.
 */
export function parseWorkdayPostedOn(value: unknown, now: Date = new Date()): Date | null {
  const text = asText(value).toLowerCase();
  if (text.length === 0) return null;

  if (text.includes("today") || text.includes("just posted")) return now;

  const daysAgo = /posted\s+(\d+)\+?\s*days?\s+ago/.exec(text);
  // The "+" is what makes the range open, so it is read before the number is
  // trusted: "30+" carries a digit and still means "at least".
  if (daysAgo && !/\d\+/.test(text)) {
    const days = Number(daysAgo[1]);
    if (Number.isFinite(days) && days >= 0 && days < 3650) {
      return new Date(now.getTime() - days * 86_400_000);
    }
    return null;
  }

  if (text.includes("yesterday")) return new Date(now.getTime() - 86_400_000);

  return null;
}

/** Workday refuses limits above this — 50 and 100 both return zero postings. */
const PAGE_SIZE = 20;

/**
 * Five pages, so one employer cannot spend the sweep window by itself.
 *
 * With newest-first ordering this is the freshest 100 postings per board, which
 * comfortably covers the 720h window for every board in the registry. A board
 * posting more than 100 roles inside 30 days loses only its oldest.
 */
const MAX_PAGES = 5;

export const workdayAdapter: AtsAdapter = {
  platformName: "workday",

  paging: { pageSize: PAGE_SIZE, maxPages: MAX_PAGES } satisfies BoardPaging,

  getBoardUrl(board: FreeBoard): string {
    return `${cxs(coordsOrThrow(board))}/jobs`;
  },

  getBoardRequest(board: FreeBoard, offset: number): BoardRequest {
    return {
      url: `${cxs(coordsOrThrow(board))}/jobs`,
      method: "POST",
      body: JSON.stringify({ limit: PAGE_SIZE, offset, appliedFacets: {}, searchText: "" }),
    };
  },

  getWireFormat(): "json" {
    return "json";
  },

  totalFrom(payload: unknown): number | null {
    const total = asRecord(payload)?.["total"];
    return typeof total === "number" && Number.isFinite(total) ? total : null;
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const coords = parseWorkdayToken(board.token);
    if (coords === null) return [];

    const root = asRecord(payload);
    const postings = Array.isArray(root?.["jobPostings"]) ? (root["jobPostings"] as unknown[]) : [];

    return postings.flatMap((raw) => {
      const job = asRecord(raw);
      if (job === null) return [];

      const title = asText(job["title"]);
      // The path IS the identifier: it is unique per posting, and it is the only
      // thing that can rebuild the detail URL, which `bulletFields` cannot.
      const externalPath = asText(job["externalPath"]);
      if (title.length === 0 || externalPath.length === 0) return [];

      return [
        {
          board,
          externalId: externalPath,
          title,
          url: `${origin(coords)}/${coords.site}${externalPath}`,
          location: asText(job["locationsText"]),
          postedAt: parseWorkdayPostedOn(job["postedOn"]),
          description: null, // Workday withholds bodies from the list payload.
        },
      ];
    });
  },

  getJobUrl(board: FreeBoard, externalId: string): string | null {
    const coords = parseWorkdayToken(board.token);
    if (coords === null || !externalId.startsWith("/")) return null;
    return `${cxs(coords)}${externalId}`;
  },

  extractBody(payload: Record<string, unknown>): string {
    // jobDescription is raw HTML, same defect as Greenhouse's extractBody —
    // fixed alongside it 2026-08-24 (see that adapter's comment for the
    // production evidence). Every other adapter's body-reading path already
    // runs decodeJobBody; this one and Greenhouse's were the two exceptions.
    const info = asRecord(payload["jobPostingInfo"]);
    return decodeJobBody(asText(info?.["jobDescription"]));
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    const url = postingUrl.replace(/\/+$/, "");
    return url.endsWith("/apply") ? url : `${url}/apply`;
  },
};
