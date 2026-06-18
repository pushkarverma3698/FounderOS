/**
 * Deterministic GitHub read fast path — bypass the LLM for simple issue lists.
 * Engineering was hallucinating issue titles without calling github_read (stress u3).
 * Pure detection + direct tool call (rule #16), same pattern as inbox-fast-path.ts.
 */

import { githubTool } from "../tools/github.js";
import { isGithubReadOnlyRequest } from "./execution-guard.js";

export { isGithubReadOnlyRequest } from "./execution-guard.js";

export function parseGithubOwnerRepo(input: string): { owner: string; repo: string } | null {
  const match = input.match(/\b([\w-]+)\/([\w.-]+)\b/);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2].replace(/[.,;:!?]+$/, "") };
}

export function githubListLimit(input: string): number {
  const match = input.match(/\bmax(?:imum)?\s+(\d+)\b/i);
  if (!match?.[1]) return 10;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : 10;
}

function isListIssuesRequest(input: string): boolean {
  return /\b(list|show|get|what are)\b[^.?!]{0,60}\b(open )?(issues?|pull requests?|prs?)\b/i.test(input);
}

function formatIssueTitles(data: unknown, limit: number): string | null {
  if (!Array.isArray(data)) return null;
  const titles = data
    .slice(0, limit)
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const title = (row as { title?: string }).title;
      const number = (row as { number?: number }).number;
      if (!title) return null;
      return number != null ? `#${number} ${title}` : title;
    })
    .filter((line): line is string => Boolean(line));
  if (titles.length === 0) return "No open issues found.";
  return `Open issues (top ${titles.length}):\n\n${titles.map((t) => `• ${t}`).join("\n")}`;
}

/**
 * Execute github list_issues directly when the request is a simple read-only issue list.
 * Returns formatted text for Telegram, or null to fall through to the office.
 */
export async function tryGithubReadFastPath(input: string): Promise<string | null> {
  if (!isGithubReadOnlyRequest(input) || !isListIssuesRequest(input)) return null;

  const pair = parseGithubOwnerRepo(input);
  if (!pair) return null;

  const res = await githubTool.execute({
    action: "list_issues",
    owner: pair.owner,
    repo: pair.repo,
  });

  if (!res.success) {
    return `❌ GitHub read failed: ${res.error ?? "unknown error"}. Check GITHUB_TOKEN in .env.`;
  }

  const formatted = formatIssueTitles(res.data, githubListLimit(input));
  if (!formatted) {
    return `❌ GitHub returned unexpected data for ${pair.owner}/${pair.repo}.`;
  }
  return formatted;
}
