/**
 * FounderOS — goals: the metric registry (closed) and its evaluator
 * =================================================================
 * Progress has to come from real events, not from what a model says. A goal names one metric key,
 * the code computes it, and there is no way to add a key without editing this file:
 *
 *   applications_7d:<profile_id>   agents.job_applications.applied_at in the last 7 days
 *   prs_merged_7d:<owner/repo>     GitHub: pull requests merged in the last 7 days
 *   issues_closed_7d:<owner/repo>  GitHub: issues closed in the last 7 days
 *   action_count_7d:<action>       agents.action_log rows of that action in the last 7 days
 *   manual                         the value the founder last reported with /goal <n> <value>
 *
 * Every failure is a value, not an exception: `{ ok: false, error }` is what the standup prints as
 * "metric unavailable: <reason>". A source that fails is never rendered as 0. All I/O is behind
 * `MetricDeps` (see metric-deps.ts for the real one), so this module is pure and offline.
 */

import { localDateKey } from "./local-date.js";
import { MetricSourceError, describeSourceError } from "./metric-errors.js";
import { formatNumber } from "./numeric.js";
import { isRepoSlug, isSafeToken } from "./tokens.js";
import type { MetricKind } from "./types.js";

export { isSafeToken } from "./tokens.js";

export const METRIC_KEYS = ["applications_7d", "prs_merged_7d", "issues_closed_7d", "action_count_7d", "manual"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** Length of the rolling window every `_7d` metric counts over. */
export const WINDOW_DAYS = 7;
/** A metric source that has not answered in this long is stopped and reported unavailable. */
export const METRIC_TIMEOUT_MS = 20_000;

export type MetricArgKind = "profile" | "repo" | "action";

export interface MetricDef {
  readonly key: MetricKey;
  readonly kind: MetricKind;
  /** What the key's `:<arg>` is, or null when it takes none. */
  readonly arg: MetricArgKind | null;
  /** Where the number comes from: used to word a failure. */
  readonly source: "database" | "github" | "founder";
  /** One line the code shows when it asks the founder to choose a key. */
  readonly summary: string;
}

/** The whole registry. Closed: no key exists that is not listed here. */
export const METRICS: Readonly<Record<MetricKey, MetricDef>> = {
  applications_7d: {
    key: "applications_7d",
    kind: "rolling",
    arg: "profile",
    source: "database",
    summary: "applications recorded for a candidate in the last 7 days",
  },
  prs_merged_7d: {
    key: "prs_merged_7d",
    kind: "rolling",
    arg: "repo",
    source: "github",
    summary: "pull requests merged in a repo in the last 7 days",
  },
  issues_closed_7d: {
    key: "issues_closed_7d",
    kind: "rolling",
    arg: "repo",
    source: "github",
    summary: "issues closed in a repo in the last 7 days",
  },
  action_count_7d: {
    key: "action_count_7d",
    kind: "rolling",
    arg: "action",
    source: "database",
    summary: "actions of one kind logged in the last 7 days",
  },
  manual: { key: "manual", kind: "cumulative", arg: null, source: "founder", summary: "a value you report yourself with /goal <n> <value>" },
};

export function isMetricKey(text: string): text is MetricKey {
  return Object.hasOwn(METRICS, text);
}

export function metricKind(key: MetricKey): MetricKind {
  return METRICS[key].kind;
}

/** The I/O the registry needs. Real implementation: metric-deps.ts. Tests pass fakes. */
export interface MetricDeps {
  countApplications(profileId: string, since: Date, until: Date): Promise<number>;
  countActions(action: string, since: Date, until: Date): Promise<number>;
  countMergedPrs(repo: string, since: Date, until: Date): Promise<number>;
  countClosedIssues(repo: string, since: Date, until: Date): Promise<number>;
}

/** The slice of a goal a metric needs. */
export interface MetricSubject {
  readonly metric_key: string;
  readonly metric_arg: string | null;
  readonly manual_value: number | null;
  readonly manual_value_at: Date | null;
}

export interface EvalContext {
  readonly now: Date;
  readonly timeZone: string;
  readonly timeoutMs?: number;
}

export type MetricOutcome =
  | { readonly ok: true; readonly value: number; readonly evidence: string }
  | { readonly ok: false; readonly error: string };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const fail = (error: string): MetricOutcome => ({ ok: false, error });

/** Rejects with a timeout MetricSourceError when `work` has not settled in `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MetricSourceError("timeout", "metric source timed out", ms)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Is `arg` acceptable for this key? A message names what is wrong; null means fine. */
export function metricArgProblem(key: MetricKey, arg: string | null): string | null {
  const need = METRICS[key].arg;
  if (need === null) return arg === null ? null : `${key} takes no argument.`;
  if (arg === null) return `${key} needs ${need === "repo" ? "an owner/repo" : need === "profile" ? "a profile id" : "an action name"}.`;
  if (need === "repo") return isRepoSlug(arg) ? null : "the repo must look like owner/repo, letters, digits, . _ - only.";
  return isSafeToken(arg) ? null : `the ${need} must be a plain id: letters, digits, . _ - only.`;
}

/**
 * Compute one goal's metric. Never throws and never returns a made-up value: a source that fails or
 * times out, a bad stored argument, or an unknown key all come back as `{ ok: false, error }`.
 */
export async function evaluateMetric(goal: MetricSubject, deps: MetricDeps, ctx: EvalContext): Promise<MetricOutcome> {
  if (!isMetricKey(goal.metric_key)) {
    const shown = isSafeToken(goal.metric_key) ? `'${goal.metric_key}'` : "the stored key";
    return fail(`${shown} is not a metric this version knows. Valid keys: ${METRIC_KEYS.join(", ")}.`);
  }
  const key = goal.metric_key;
  const def = METRICS[key];

  if (key === "manual") {
    if (goal.manual_value === null || !Number.isFinite(goal.manual_value)) {
      return fail("no value reported yet. Send /goal <n> <value> (n is the goal's number in /goals) to report one.");
    }
    const on = goal.manual_value_at ? localDateKey(goal.manual_value_at, ctx.timeZone) : "an unknown date";
    return { ok: true, value: goal.manual_value, evidence: `reported as ${formatNumber(goal.manual_value)} on ${on}` };
  }

  const arg = goal.metric_arg;
  if (metricArgProblem(key, arg) !== null || arg === null) {
    return fail(`the stored argument for ${key} is not a plain id, so nothing was read. Re-add the goal with a valid ${def.arg}.`);
  }

  const until = ctx.now;
  const since = new Date(until.getTime() - WINDOW_DAYS * 86_400_000);
  const span = `from ${localDateKey(since, ctx.timeZone)} to ${localDateKey(until, ctx.timeZone)}`;

  try {
    const read = ((): Promise<number> => {
      switch (key) {
        case "applications_7d":
          return deps.countApplications(arg, since, until);
        case "prs_merged_7d":
          return deps.countMergedPrs(arg, since, until);
        case "issues_closed_7d":
          return deps.countClosedIssues(arg, since, until);
        case "action_count_7d":
          return deps.countActions(arg, since, until);
      }
    })();
    const count = await withTimeout(read, ctx.timeoutMs ?? METRIC_TIMEOUT_MS);
    if (!Number.isInteger(count) || count < 0) return fail(`the source returned ${Number.isFinite(count) ? "a count that is not a whole number" : "a value that is not a number"}, so it was not used.`);
    const evidence = {
      applications_7d: `${count} ${plural(count, "application", "applications")} for ${arg} ${span}`,
      prs_merged_7d: `${count} ${plural(count, "pull request", "pull requests")} merged in ${arg} ${span}`,
      issues_closed_7d: `${count} ${plural(count, "issue", "issues")} closed in ${arg} ${span}`,
      action_count_7d: `${count} ${arg} ${plural(count, "action", "actions")} logged ${span}`,
    }[key];
    return { ok: true, value: count, evidence };
  } catch (err) {
    // allow-failopen: this IS the reporting path. The failure is returned as { ok:false, error } and shown to the founder as "metric unavailable: <reason>"; nothing is swallowed.
    return fail(describeSourceError(err, { source: def.source === "github" ? "github" : "database", subject: arg }));
  }
}
