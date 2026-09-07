/**
 * FounderOS — Arbeitnow aggregator adapter
 * ==========================================
 * Fetch EU/NL job listings from the Arbeitnow public API.
 *
 * Arbeitnow is Berlin-based, EU-focused, and offers a free paginated JSON API
 * with no authentication. It supports a `visa_sponsorship=true` filter which is
 * high-value for our use case. Data refreshes hourly.
 *
 * Endpoint: GET https://www.arbeitnow.com/api/job-board-api?page=N
 * Rate limit: polite sequential requests (~1 req/s), no hard numeric cap.
 * Response: { data: Job[], links: { next }, meta: { current_page } }
 */

import type { AggregatorJob, AggregatorSource } from "./types.js";

/** Maximum pages to fetch per sweep. Each page is ~20–25 jobs. */
const MAX_PAGES = 10;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "founderos-aggregator/1.0 (+jobhunt)";

/** Inter-request delay to stay polite (ms). */
const PAGE_DELAY_MS = 1_200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wire shape of one Arbeitnow job. */
interface ArbeitnowJob {
  readonly slug?: string;
  readonly company_name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly remote?: boolean;
  readonly url?: string;
  readonly tags?: readonly string[];
  readonly job_types?: readonly string[];
  readonly location?: string;
  readonly created_at?: number; // Unix timestamp (seconds)
}

interface ArbeitnowResponse {
  readonly data?: readonly ArbeitnowJob[];
  readonly links?: { readonly next?: string | null };
  readonly meta?: { readonly current_page?: number };
}

function toAggregatorJob(raw: ArbeitnowJob): AggregatorJob | null {
  const title = (raw.title ?? "").trim();
  const company = (raw.company_name ?? "").trim();
  const url = (raw.url ?? "").trim();
  if (title.length === 0 || company.length === 0 || url.length === 0) return null;

  return {
    title,
    company,
    url,
    location: (raw.location ?? "").trim(),
    description: (raw.description ?? "").trim(),
    postedAt: typeof raw.created_at === "number" && raw.created_at > 0
      ? new Date(raw.created_at * 1000)
      : null,
    source: "arbeitnow",
    tags: raw.tags ?? [],
  };
}

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
let lastFetchTime = 0;

async function fetchPage(page: number): Promise<ArbeitnowResponse | null> {
  const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        return (await response.json()) as ArbeitnowResponse;
      }
      if (response.status === 429 || response.status >= 500) {
        console.warn(`arbeitnow: page ${page} HTTP ${response.status}, attempt ${attempt}/3`);
        await sleep(process.env.NODE_ENV === "test" ? 1 : PAGE_DELAY_MS * attempt * 2);
        continue;
      }
      return null; // Not retryable (e.g. 404)
    } catch (err) {
      console.warn(`arbeitnow: page ${page} network err, attempt ${attempt}/3 —`, err instanceof Error ? err.message : String(err));
      await sleep(process.env.NODE_ENV === "test" ? 1 : PAGE_DELAY_MS * attempt * 2);
    }
  }
  return null;
}

export function createArbeitnowSource(): AggregatorSource {
  return {
    name: "arbeitnow",
    async fetchJobs(): Promise<readonly AggregatorJob[]> {
      const now = Date.now();
      if (now - lastFetchTime < COOLDOWN_MS && process.env.NODE_ENV !== "test") {
        return [];
      }
      lastFetchTime = now;

      const jobs: AggregatorJob[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await fetchPage(page);
        if (!response?.data || response.data.length === 0) break;

        for (const raw of response.data) {
          const job = toAggregatorJob(raw);
          if (job !== null) jobs.push(job);
        }

        // Stop when there is no next page.
        if (!response.links?.next) break;
        if (page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
      }

      return jobs;
    },
  };
}
