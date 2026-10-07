/**
 * GitHub code reading for github_read (AG-035): get_file and search_code.
 * Read-only, through the GitHub API with the existing token (no new scopes).
 * Split out of github.ts to keep that file under the LOC budget.
 */

import type { Octokit } from "octokit";
import type { ToolResult } from "./index.js";

export const GET_FILE_MAX_LINES = 400;
export const SEARCH_CODE_MAX_HITS = 20;

export function renderFile(path: string, b64: string, ref?: string): ToolResult {
  const lines = Buffer.from(b64, "base64").toString("utf8").split("\n");
  const total = lines.length;
  const shown = lines.slice(0, GET_FILE_MAX_LINES).map((l, i) => String(i + 1) + ": " + l);
  const truncated = total > GET_FILE_MAX_LINES;
  const data = { path, ...(ref ? { ref } : {}), total_lines: total, truncated, content: shown.join("\n") };
  const note = "truncated: showing lines 1-" + GET_FILE_MAX_LINES + " of " + total;
  return truncated ? { success: true, data, truncated: true, note } : { success: true, data };
}

/** First line (1-based) containing the longest term of the query, case-insensitive; null when none. */
type Hit = { line: number; text: string };
export function findHitLine(content: string, query: string): Hit | null {
  const terms = query.split(/\s+/).filter((t) => t.length >= 2 && t.includes(":") === false);
  const term = terms.sort((a, b) => b.length - a.length)[0]?.toLowerCase();
  if (term === undefined) return null;
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.toLowerCase().includes(term));
  return idx === -1 ? null : { line: idx + 1, text: lines[idx]!.trim().slice(0, 160) };
}

export async function getFile(octokit: Octokit, owner: string, repo: string, path: string, ref?: string): Promise<ToolResult> {
  const args = { owner, repo, path, ...(ref ? { ref } : {}) };
  const { data } = await octokit.rest.repos.getContent(args);
  if (Array.isArray(data)) {
    const names = data.map((e) => e.name).slice(0, 30).join(", ");
    return { success: false, error: path + " is a directory: " + names + ". get_file needs a file path." };
  }
  const body = data as { type: string; content?: string };
  if (body.type !== "file" || typeof body.content !== "string") return { success: false, error: path + " is not a regular file" };
  return renderFile(path, body.content, ref);
}

type Item = { path: string };

async function hitFor(octokit: Octokit, owner: string, repo: string, item: Item, query: string): Promise<Record<string, unknown>> {
  try {
    const file = await octokit.rest.repos.getContent({ owner, repo, path: item.path });
    const body = file.data as { content?: string };
    if (Array.isArray(file.data) || typeof body.content !== "string") return { path: item.path };
    const hit = findHitLine(Buffer.from(body.content, "base64").toString("utf8"), query);
    return hit ? { path: item.path, line: hit.line, ref: item.path + ":" + hit.line, text: hit.text } : { path: item.path };
  } catch {
    // allow-failopen: a hit whose file cannot be fetched is still reported by path, without a line number
    return { path: item.path };
  }
}

export async function searchCode(octokit: Octokit, owner: string, repo: string, query: string): Promise<ToolResult> {
  const q = query + " repo:" + owner + "/" + repo;
  const { data } = await octokit.rest.search.code({ q, per_page: SEARCH_CODE_MAX_HITS });
  const items = data.items.slice(0, SEARCH_CODE_MAX_HITS);
  const hits = await Promise.all(items.map((item) => hitFor(octokit, owner, repo, item, query)));
  return { success: true, data: { total_count: data.total_count, hits } };
}
