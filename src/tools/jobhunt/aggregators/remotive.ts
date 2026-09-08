/**
 * FounderOS — Remotive aggregator adapter
 * =========================================
 * Fetch remote job listings from the Remotive public API.
 *
 * Remotive is a remote-jobs aggregator with a free JSON API. Important caveat:
 * they enforce a STRICT rate limit of ~2 req/min and recommend ≤4 req/DAY.
 * The free feed is delayed by 24 hours vs. their paid feed. Because of this,
 * we fetch once per sweep with a single request (no pagination needed — a
 * single GET returns all active listings up to a `limit`).
 *
 * Endpoint: GET https://remotive.com/api/remote-jobs?limit=200&category=software-dev
 * Rate limit: 2 req/min hard, 4 req/day recommended.
 * Response: { "job-count": N, jobs: Job[] }
 */

import type { AggregatorJob, AggregatorSource } from "./types.js";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "founderos-aggregator/1.0 (+jobhunt)";

/** Fetch software-dev category to focus on engineering roles. */
const CATEGORY = "software-dev";
const LIMIT = 200;

/** Wire shape of one Remotive job. */
interface RemotiveJob {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
  readonly company_name?: string;
  readonly company_logo?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly job_type?: string;
  readonly publication_date?: string; // ISO date string
  readonly candidate_required_location?: string;
  readonly salary?: string;
  readonly description?: string;
}

interface RemotiveResponse {
  readonly "job-count"?: number;
  readonly jobs?: readonly RemotiveJob[];
}

function toAggregatorJob(raw: RemotiveJob): AggregatorJob | null {
  const title = (raw.title ?? "").trim();
  const company = (raw.company_name ?? "").trim();
  const url = (raw.url ?? "").trim();
  if (title.length === 0 || company.length === 0 || url.length === 0) return null;

  let postedAt: Date | null = null;
  if (typeof raw.publication_date === "string" && raw.publication_date.trim().length > 0) {
    const parsed = new Date(raw.publication_date.trim());
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return {
    title,
    company,
    url,
    location: (raw.candidate_required_location ?? "").trim(),
    description: (raw.description ?? "").trim(),
    postedAt,
    source: "remotive",
    tags: raw.tags ?? [],
  };
}

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
let lastFetchTime = 0;

export function createRemotiveSource(): AggregatorSource {
  return {
    name: "remotive",
    async fetchJobs(): Promise<readonly AggregatorJob[]> {
      const now = Date.now();
      if (now - lastFetchTime < COOLDOWN_MS && process.env.NODE_ENV !== "test") {
        return [];
      }
      lastFetchTime = now;
      try {
        const url = `https://remotive.com/api/remote-jobs?category=${CATEGORY}&limit=${LIMIT}`;
        const response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          console.warn(`remotive: HTTP ${response.status}`);
          return [];
        }
        const data = (await response.json()) as RemotiveResponse;
        if (!data.jobs) return [];

        const jobs: AggregatorJob[] = [];
        for (const raw of data.jobs) {
          const job = toAggregatorJob(raw);
          if (job !== null) jobs.push(job);
        }
        return jobs;
      } catch (err) {
        // allow-failopen: a broken aggregator must not take down the sweep
        console.warn(`remotive: fetch failed —`, err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  };
}
