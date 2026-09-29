/**
 * FounderOS — goals: why a metric could not be read
 * =================================================
 * "metric unavailable: <reason>" is what the founder sees instead of a 0. The reason has to name
 * the failing component and the fix — and it is stored in goal_reviews.error, which feeds the later
 * "Plan next step" LLM prompt. So the reason is built ONLY from a fixed vocabulary plus numbers and
 * ids (an HTTP status, a SQLSTATE, a network code, a validated repo slug). The error's own message,
 * its response body and its headers are never copied: a GitHub or job-board response is free text
 * an attacker can write, and a header can carry a token.
 */

import { isIdentifier, isSafeToken } from "./tokens.js";

export type MetricSourceErrorKind = "no-token" | "incomplete-results" | "timeout";

/** A failure this module raised itself (as opposed to one a client library threw). */
export class MetricSourceError extends Error {
  constructor(
    readonly kind: MetricSourceErrorKind,
    message: string,
    /** For `timeout`: the limit that was exceeded, so the reason can name it. */
    readonly timeoutMs?: number,
  ) {
    super(message);
    this.name = "MetricSourceError";
  }
}

export interface ErrorContext {
  readonly source: "database" | "github";
  /** The repo, profile or action being read. Echoed only when it is a plain id. */
  readonly subject: string | null;
}

const NEXT_STANDUP = "It is tried again at the next standup.";

/** SQLSTATE: five characters of 0-9 A-Z with at least one digit (class code + subclass). */
function isSqlState(code: unknown): code is string {
  return (
    typeof code === "string" &&
    code.length === 5 &&
    [...code].every((c) => (c >= "0" && c <= "9") || (c >= "A" && c <= "Z")) &&
    [...code].some((c) => c >= "0" && c <= "9")
  );
}

/** A Node/libuv network code: ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE. E, then capitals and `_`, no digits. */
function isNetworkCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    code.length >= 4 &&
    code.length <= 30 &&
    code.startsWith("E") &&
    [...code].every((c) => (c >= "A" && c <= "Z") || c === "_")
  );
}

function githubStatusReason(status: number, repo: string): string {
  switch (status) {
    case 401:
      return `GitHub rejected the token (HTTP 401). Fix: replace GITHUB_TOKEN on the server with a valid token that can read ${repo}.`;
    case 403:
      return `GitHub refused the request (HTTP 403: rate limit or missing permission for ${repo}). Fix: check that GITHUB_TOKEN can read ${repo}. ${NEXT_STANDUP}`;
    case 404:
    case 422:
      return `GitHub cannot search ${repo} (HTTP ${status}). Fix: check the owner/repo spelling in the goal's metric, and that GITHUB_TOKEN can see the repository.`;
    case 429:
      return `GitHub rate-limited the check (HTTP 429). ${NEXT_STANDUP}`;
    default:
      return status >= 500
        ? `GitHub had a server error (HTTP ${status}). ${NEXT_STANDUP}`
        : `GitHub answered HTTP ${status}, which the standup cannot use.`;
  }
}

/**
 * The reason a metric read failed, for the founder and for the prompt. Never throws, never returns
 * an empty string, and never contains text from the error itself.
 */
export function describeSourceError(err: unknown, ctx: ErrorContext): string {
  const repo = ctx.subject !== null && isSafeToken(ctx.subject) ? ctx.subject : "the repository";

  if (err instanceof MetricSourceError) {
    switch (err.kind) {
      case "no-token":
        return "GITHUB_TOKEN is not set on the server. Fix: add a GitHub token that can read the repository to the server's environment (GITHUB_TOKEN) and restart.";
      case "incomplete-results":
        return `GitHub returned incomplete search results for ${repo}, so the count could not be trusted. ${NEXT_STANDUP}`;
      case "timeout":
        return `the check took longer than ${Math.max(1, Math.ceil((err.timeoutMs ?? 0) / 1000))}s and was stopped. ${NEXT_STANDUP}`;
    }
  }

  const record: Record<string, unknown> = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
  const status = record["status"];
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return githubStatusReason(status, repo);
  }

  const cause = typeof record["cause"] === "object" && record["cause"] !== null ? (record["cause"] as Record<string, unknown>) : {};
  const code = record["code"] ?? cause["code"];
  if (isNetworkCode(code)) {
    return ctx.source === "github"
      ? `GitHub could not be reached (network error ${code}). ${NEXT_STANDUP}`
      : `the database could not be reached (${code}). Fix: check that Postgres is up. ${NEXT_STANDUP}`;
  }
  if (isSqlState(code)) {
    return `the database query failed (SQLSTATE ${code}). Fix: check that Postgres is up and migration 0042_goals is applied (pnpm setup).`;
  }

  const name = typeof record["name"] === "string" && isIdentifier(record["name"]) ? record["name"] : "error";
  return `unexpected ${name} while reading ${ctx.source === "github" ? "GitHub" : "the database"}. Fix: check the server log for the goals standup.`;
}
