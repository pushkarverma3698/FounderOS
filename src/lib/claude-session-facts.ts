/**
 * Session facts that `distillSession` does not carry: title, repo cwd, branch, PR links, files edited,
 * start and end time (AG-027). Pure, like claude-transcript.ts, which owns the founder/assistant prose.
 *
 * Reads only metadata fields and the `file_path` argument of Edit/Write tool calls. It never reads
 * `tool_result` content or any tool input body, so file contents and command output cannot leak through here.
 */

/** Tool calls whose `file_path` argument names a file the session changed. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface SessionFacts {
  readonly title: string | null;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly prLinks: readonly string[];
  readonly editedFiles: readonly string[];
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

interface FactsLine {
  type?: unknown;
  customTitle?: unknown;
  prUrl?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function editedPaths(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content as Array<{ type?: unknown; name?: unknown; input?: { file_path?: unknown } }>) {
    if (block?.type !== "tool_use" || typeof block.name !== "string" || !EDIT_TOOL_NAMES.has(block.name)) continue;
    const path = asString(block.input?.file_path);
    if (path) paths.push(path);
  }
  return paths;
}

export function extractSessionFacts(jsonlText: string): SessionFacts {
  let title: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  const prLinks = new Set<string>();
  const editedFiles = new Set<string>();

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: FactsLine;
    try {
      raw = JSON.parse(trimmed) as FactsLine;
    } catch {
      continue; // allow-failopen: a live session ends mid-line; distillSession already counts malformed lines
    }
    if (raw.type === "custom-title") title = asString(raw.customTitle) ?? title;
    if (raw.type === "pr-link") {
      const url = asString(raw.prUrl);
      if (url) prLinks.add(url);
    }
    cwd = asString(raw.cwd) ?? cwd;
    branch = asString(raw.gitBranch) ?? branch;
    if (typeof raw.timestamp === "string") {
      const at = new Date(raw.timestamp);
      if (!Number.isNaN(at.getTime())) {
        if (!startedAt || at < startedAt) startedAt = at;
        if (!endedAt || at > endedAt) endedAt = at;
      }
    }
    if (raw.type === "assistant") for (const p of editedPaths(raw.message?.content)) editedFiles.add(p);
  }

  return { title, cwd, branch, prLinks: [...prLinks], editedFiles: [...editedFiles], startedAt, endedAt };
}
