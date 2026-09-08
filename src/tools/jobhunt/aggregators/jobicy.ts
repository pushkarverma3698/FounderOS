/**
 * FounderOS — Jobicy aggregator adapter
 * ========================================
 * Fetch remote job listings from the Jobicy public API.
 *
 * Jobicy is a remote-jobs aggregator with an EU focus. The API returns up to
 * 200 jobs in a single request with no pagination — just a `count` parameter.
 * Supports geo filtering via `?geo=europe`.
 *
 * Endpoint: GET https://jobicy.com/api/v2/remote-jobs?count=200&geo=europe
 * Rate limit: fair-use, poll every few hours.
 * Response: { jobs: Job[], jobCount: N }
 */

import type { AggregatorJob, AggregatorSource } from "./types.js";

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "founderos-aggregator/1.0 (+jobhunt)";
const COUNT = 200;

/** Wire shape of one Jobicy job. */
interface JobicyJob {
  readonly id?: number;
  readonly url?: string;
  readonly jobSlug?: string;
  readonly jobTitle?: string;
  readonly companyName?: string;
  readonly companyLogo?: string;
  readonly jobIndustry?: readonly string[];
  readonly jobType?: readonly string[];
  readonly jobGeo?: string;
  readonly jobLevel?: string;
  readonly jobExcerpt?: string;
  readonly jobDescription?: string;
  readonly pubDate?: string; // ISO date or human-readable string
  readonly annualSalaryMin?: number;
  readonly annualSalaryMax?: number;
  readonly salaryCurrency?: string;
}

interface JobicyResponse {
  readonly jobCount?: number;
  readonly jobs?: readonly JobicyJob[];
}

function toAggregatorJob(raw: JobicyJob): AggregatorJob | null {
  const title = (raw.jobTitle ?? "").trim();
  const company = (raw.companyName ?? "").trim();
  const url = (raw.url ?? "").trim();
  if (title.length === 0 || company.length === 0 || url.length === 0) return null;

  let postedAt: Date | null = null;
  if (typeof raw.pubDate === "string" && raw.pubDate.trim().length > 0) {
    const parsed = new Date(raw.pubDate.trim());
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return {
    title,
    company,
    url,
    location: (raw.jobGeo ?? "").trim(),
    description: (raw.jobDescription ?? raw.jobExcerpt ?? "").trim(),
    postedAt,
    source: "jobicy",
    tags: raw.jobIndustry ?? [],
  };
}

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
let lastFetchTime = 0;

export function createJobicySource(): AggregatorSource {
  return {
    name: "jobicy",
    async fetchJobs(): Promise<readonly AggregatorJob[]> {
      const now = Date.now();
      if (now - lastFetchTime < COOLDOWN_MS && process.env.NODE_ENV !== "test") {
        return [];
      }
      lastFetchTime = now;

      const url = `https://jobicy.com/api/v2/remote-jobs?count=${COUNT}&geo=europe`;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (response.ok) {
            const data = (await response.json()) as JobicyResponse;
            if (!data.jobs) return [];
    
            const jobs: AggregatorJob[] = [];
            for (const raw of data.jobs) {
              const job = toAggregatorJob(raw);
              if (job !== null) jobs.push(job);
            }
            return jobs;
          }
          if (response.status === 429 || response.status >= 500) {
            console.warn(`jobicy: HTTP ${response.status}, attempt ${attempt}/3`);
            await new Promise(r => setTimeout(r, process.env.NODE_ENV === "test" ? 1 : attempt * 2000));
            continue;
          }
          return [];
        } catch (err) {
          console.warn(`jobicy: network err, attempt ${attempt}/3 —`, err instanceof Error ? err.message : String(err));
          await new Promise(r => setTimeout(r, process.env.NODE_ENV === "test" ? 1 : attempt * 2000));
        }
      }
      return [];
    },
  };
}
