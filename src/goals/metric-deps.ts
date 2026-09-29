/**
 * FounderOS — goals: the real metric sources (the collector)
 * ===========================================================
 * All I/O the metric registry needs, and nothing else: it fetches and counts, it does not decide.
 * Two halves:
 *   database   applications and logged actions, straight from agents.job_applications / action_log
 *   GitHub     merged PRs and closed issues, one search call each, reading only `total_count`
 *
 * Every function takes its client as a parameter, so the unit tests use a fake and never touch a
 * network or a database. `createRealMetricDeps` is the one place that binds the real ones.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { TENANT } from "../core/config.js";
import { getDb } from "../db/client.js";
import { actionLog, jobApplications } from "../db/schema.js";
import type { MetricDeps } from "./metrics.js";
import { MetricSourceError } from "./metric-errors.js";
import { parseNumeric } from "./numeric.js";
import { isRepoSlug } from "./tokens.js";

/** The one GitHub call the standup makes: issue/PR search, of which only the total is read. */
export interface SearchClient {
  readonly rest: {
    readonly search: {
      issuesAndPullRequests(params: { q: string; per_page: number }): Promise<{
        data: { total_count: number; incomplete_results: boolean };
      }>;
    };
  };
}

/** `GITHUB_TOKEN` → an Octokit. Lazy import: nothing pays for Octokit until a GitHub metric runs. */
export async function githubClientFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SearchClient> {
  const token = env["GITHUB_TOKEN"];
  if (!token) throw new MetricSourceError("no-token", "GITHUB_TOKEN not configured");
  const { Octokit } = await import("octokit");
  return new Octokit({ auth: token });
}

/** `2026-09-22T09:00:00Z`: a search qualifier takes second precision, not milliseconds. */
const searchInstant = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;

async function searchTotal(getClient: () => Promise<SearchClient>, query: string): Promise<number> {
  const client = await getClient();
  const { data } = await client.rest.search.issuesAndPullRequests({ q: query, per_page: 1 });
  // A timed-out search answers 200 with a partial list. A count that may be low is worse than no count.
  if (data.incomplete_results) throw new MetricSourceError("incomplete-results", "GitHub search was incomplete");
  const total: unknown = data.total_count;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new Error("GitHub search returned no usable total_count");
  }
  return total;
}

function requireRepo(repo: string): void {
  // Defence in depth: evaluateMetric already refuses a bad stored repo, and this is the last line
  // before the string is interpolated into a search query.
  if (!isRepoSlug(repo)) throw new Error("refusing to search a repo that is not a plain owner/repo");
}

export function createGitHubCounts(
  getClient: () => Promise<SearchClient> = () => githubClientFromEnv(),
): Pick<MetricDeps, "countMergedPrs" | "countClosedIssues"> {
  return {
    async countMergedPrs(repo, since, until) {
      requireRepo(repo);
      return searchTotal(getClient, `repo:${repo} is:pr is:merged merged:${searchInstant(since)}..${searchInstant(until)}`);
    },
    async countClosedIssues(repo, since, until) {
      requireRepo(repo);
      return searchTotal(getClient, `repo:${repo} is:issue is:closed closed:${searchInstant(since)}..${searchInstant(until)}`);
    },
  };
}

type Db = ReturnType<typeof getDb>;

function requireCount(row: { n: unknown } | undefined): number {
  const n = parseNumeric(row?.n);
  if (n === null || !Number.isInteger(n) || n < 0) throw new Error("count query returned no usable row");
  return n;
}

export function createDbCounts(db: Db, tenant: string): Pick<MetricDeps, "countApplications" | "countActions"> {
  return {
    async countApplications(profileId, since, until) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(jobApplications)
        .where(
          and(
            eq(jobApplications.tenant_id, tenant),
            eq(jobApplications.profile_id, profileId),
            gte(jobApplications.applied_at, since),
            lte(jobApplications.applied_at, until),
          ),
        );
      return requireCount(row);
    },
    async countActions(action, since, until) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(actionLog)
        .where(and(eq(actionLog.tenant_id, tenant), eq(actionLog.action, action), gte(actionLog.created_at, since), lte(actionLog.created_at, until)));
      return requireCount(row);
    },
  };
}

/** The production wiring: real Postgres (this tenant) and real GitHub (the server's token). */
export function createRealMetricDeps(): MetricDeps {
  return { ...createDbCounts(getDb(), TENANT), ...createGitHubCounts() };
}
