/**
 * FounderOS — Himalayas aggregator adapter
 * ==========================================
 * Fetch remote job listings from the Himalayas public API.
 *
 * Himalayas uses cursor-based pagination with a max of 20 items per request.
 * Data refreshes once every 24 hours, so polling more frequently yields nothing.
 *
 * Endpoint: GET https://himalayas.app/jobs/api?limit=20&cursor=...
 * Rate limit: fair use, no key required. Returns 429 on abuse.
 * Response: { jobs: Job[], meta: { total, nextCursor } }
 */

import type { AggregatorJob, AggregatorSource } from "./types.js";

/** Maximum pages to fetch. At 20/page, 10 pages = 200 jobs. */
const MAX_PAGES = 10;
const PAGE_SIZE = 20;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "founderos-aggregator/1.0 (+jobhunt)";

/** Inter-request delay (ms). */
const PAGE_DELAY_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wire shape of one Himalayas job. */
interface HimalayasJob {
  readonly id?: string;
  readonly title?: string;
  readonly companyName?: string;
  readonly companySlug?: string;
  readonly excerpt?: string;
  readonly description?: string;
  readonly locationRestrictions?: readonly string[];
  readonly timezoneRestrictions?: readonly string[];
  readonly salaryCurrency?: string;
  readonly minSalary?: number;
  readonly maxSalary?: number;
  readonly applicationUrl?: string;
  readonly pubDate?: string; // ISO date string
  readonly categories?: readonly string[];
}

interface HimalayasResponse {
  readonly jobs?: readonly HimalayasJob[];
  readonly meta?: {
    readonly total?: number;
    readonly nextCursor?: string | null;
  };
}

function toAggregatorJob(raw: HimalayasJob): AggregatorJob | null {
  const title = (raw.title ?? "").trim();
  const company = (raw.companyName ?? "").trim();
  const url = (raw.applicationUrl ?? "").trim();
  if (title.length === 0 || company.length === 0 || url.length === 0) return null;

  let postedAt: Date | null = null;
  if (typeof raw.pubDate === "string" && raw.pubDate.trim().length > 0) {
    const parsed = new Date(raw.pubDate.trim());
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const location = raw.locationRestrictions?.join(", ") ?? "";

  return {
    title,
    company,
    url,
    location,
    description: (raw.description ?? raw.excerpt ?? "").trim(),
    postedAt,
    source: "himalayas",
    tags: raw.categories ?? [],
  };
}

async function fetchPage(cursor: string | null): Promise<HimalayasResponse | null> {
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const url = `https://himalayas.app/jobs/api?${params.toString()}`;

    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`himalayas: HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as HimalayasResponse;
  } catch (err) {
    console.warn(`himalayas: fetch failed —`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function createHimalayasSource(): AggregatorSource {
  return {
    name: "himalayas",
    async fetchJobs(): Promise<readonly AggregatorJob[]> {
      const jobs: AggregatorJob[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await fetchPage(cursor);
        if (!response?.jobs || response.jobs.length === 0) break;

        for (const raw of response.jobs) {
          const job = toAggregatorJob(raw);
          if (job !== null) jobs.push(job);
        }

        cursor = response.meta?.nextCursor ?? null;
        if (!cursor) break;
        if (page < MAX_PAGES - 1) await sleep(PAGE_DELAY_MS);
      }

      return jobs;
    },
  };
}
