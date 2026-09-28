/**
 * Maps the turicks-brain MCP write tools (remember / save_decision / save_bug)
 * to brainIngest options. Pure, so the mapping is unit-tested without starting
 * the stdio server (tests/unit/mcp/brain-write-args.test.ts).
 *
 * `project` is accepted on all three: before 2026-09-28 `remember` dropped it,
 * so general memories were invisible to project-scoped search_memory.
 */
import type { IngestOptions } from "../db/brain-ingest.js";

const IDE_SOURCE = "ide_mcp";
const DECISION_IMPORTANCE = 0.9;
const BUG_IMPORTANCE = 0.8;

function optionalProject(args: Record<string, unknown>): string | undefined {
  const raw = args["project"];
  if (raw === undefined || raw === null) return undefined;
  const project = String(raw).trim();
  return project === "" ? undefined : project;
}

export function writeToolIngestOptions(name: string, args: Record<string, unknown>): IngestOptions | null {
  const project = optionalProject(args);
  switch (name) {
    case "remember": {
      const tags = args["tags"] ? String(args["tags"]).split(",").map((s) => s.trim()).filter(Boolean) : [];
      return { memoryType: "note", content: String(args["content"]), project, metadata: { tags }, source: IDE_SOURCE };
    }
    case "save_decision":
      return { memoryType: "decision", content: String(args["decision"]), project, importance: DECISION_IMPORTANCE, source: IDE_SOURCE };
    case "save_bug":
      return { memoryType: "bug", content: String(args["bug"]), project, importance: BUG_IMPORTANCE, source: IDE_SOURCE };
    default:
      return null;
  }
}
