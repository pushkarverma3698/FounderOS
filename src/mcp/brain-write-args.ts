/**
 * Maps the turicks-brain MCP write tools (remember / save_decision / save_bug)
 * to brainIngest options. Pure, so the mapping is unit-tested without starting
 * the stdio server (tests/unit/mcp/brain-write-args.test.ts).
 *
 * `project` is accepted on all three: before 2026-09-28 `remember` dropped it,
 * so general memories were invisible to project-scoped search_memory.
 */
import type { IngestOptions } from "../db/brain-ingest.js";
import { brainProvenanceSchema, type BrainProvenance } from "../db/brain-provenance.js";

const IDE_SOURCE = "ide_mcp";
const DECISION_IMPORTANCE = 0.9;
const BUG_IMPORTANCE = 0.8;

function optionalProject(args: Record<string, unknown>): string | undefined {
  const raw = args["project"];
  if (raw === undefined || raw === null) return undefined;
  const project = String(raw).trim();
  return project === "" ? undefined : project;
}

function optionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim();
  return v === "" ? undefined : v;
}

/**
 * Who wrote this row. BRAIN_CLIENT / BRAIN_MACHINE come from the hub's environment (the SSH launcher sets them);
 * missing means an unknown agent, never a rejected write.
 */
export function buildProvenance(
  args: Record<string, unknown>,
  visibility: BrainProvenance["visibility"],
  env: Record<string, string | undefined>,
  now: Date,
): BrainProvenance {
  return brainProvenanceSchema.parse({
    origin: "agent",
    client: optionalString(env["BRAIN_CLIENT"]) ?? "unknown",
    machine: optionalString(env["BRAIN_MACHINE"]),
    session_id: optionalString(args["session_id"]),
    repo: optionalString(args["repo"]),
    occurred_at: now.toISOString(),
    visibility,
  });
}

export function writeToolIngestOptions(
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): IngestOptions | null {
  const project = optionalProject(args);
  switch (name) {
    case "remember": {
      const tags = args["tags"] ? String(args["tags"]).split(",").map((s) => s.trim()).filter(Boolean) : [];
      return { memoryType: "note", content: String(args["content"]), project, metadata: { tags }, provenance: buildProvenance(args, "founder", env, now), source: IDE_SOURCE };
    }
    case "save_decision":
      return { memoryType: "decision", content: String(args["decision"]), project, importance: DECISION_IMPORTANCE, provenance: buildProvenance(args, "all", env, now), source: IDE_SOURCE };
    case "save_bug":
      return { memoryType: "bug", content: String(args["bug"]), project, importance: BUG_IMPORTANCE, provenance: buildProvenance(args, "all", env, now), source: IDE_SOURCE };
    default:
      return null;
  }
}
