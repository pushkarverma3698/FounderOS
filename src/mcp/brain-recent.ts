/**
 * recent_memories: the SessionStart brief. Read-only list of the newest ACTIVE decision and bug rows
 * for one project, one plain line each (id8 kind date title), so a shell hook can print it as-is.
 * Rows are tagged by save_decision / save_bug through memory_type (brain-write-args.ts).
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { brainMemories } from "../db/schema.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 40;
const TITLE_MAX = 160;
const KINDS = ["decision", "bug"];
const DAY_MS = 86_400_000;

function clampInt(raw: unknown, dflt: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (raw === undefined || raw === null || !Number.isFinite(n) || n < 1) return dflt;
  return Math.min(n, max);
}

/** First non-empty line of the memory, whitespace collapsed, cut to TITLE_MAX. */
export function memoryTitle(content: string): string {
  const first = content.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

/** Returns the plain-text brief, or throws on a missing project (callBrainTool turns that into an error result). */
export async function recentMemories(args: Record<string, unknown>): Promise<string> {
  const project = String(args["project"] ?? "").trim();
  if (project === "") throw new Error("project is required");
  const days = clampInt(args["days"], DEFAULT_DAYS, MAX_DAYS);
  const limit = clampInt(args["limit"], DEFAULT_LIMIT, MAX_LIMIT);
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db
    .select()
    .from(brainMemories)
    .where(and(
      eq(brainMemories.project, project),
      eq(brainMemories.status, "ACTIVE"),
      inArray(brainMemories.memory_type, KINDS),
      gte(brainMemories.created_at, since),
    ))
    .orderBy(desc(brainMemories.created_at))
    .limit(limit);
  if (rows.length === 0) return `No decisions or bugs for ${project} in the last ${days} days.`;
  return rows
    .map((r) => `${r.id.slice(0, 8)} ${r.memory_type} ${r.created_at ? r.created_at.toISOString().slice(0, 10) : "unknown"} ${memoryTitle(r.content)}`)
    .join("\n");
}

export const RECENT_MEMORIES_TOOL = {
  name: "recent_memories",
  description: "List the newest decisions and bugs saved for a project, one plain line each (id kind date title). Read-only; for a session-start brief.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project tag. Required.",
      },
      days: {
        type: "number",
        description: "Look back this many days (default 7, max 30).",
      },
      limit: {
        type: "number",
        description: "Max rows (default 15, max 40).",
      },
    },
    required: ["project"],
  },
};
