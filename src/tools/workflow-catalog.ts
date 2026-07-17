/**
 * FounderOS — Saved-workflow catalog helpers (pure)
 * =================================================
 * Deterministic naming + identity for the saved_workflows table. Kept pure and
 * in their own file (LOC budget R4) so the upsert path in db/queries.ts and the
 * agent-tool wrappers share one source of truth for how a script becomes a
 * findable, dedup-keyed workflow.
 */

import { createHash } from "node:crypto";

const MAX_SLUG_LEN = 60;

/**
 * Human-readable, S3-safe name for a workflow. Prefers the brief's first line
 * (that's the founder's own words for the job); falls back to the command.
 * Always non-empty, lowercase kebab, no leading/trailing hyphen.
 */
export function slugifyWorkflow(command: string, brief?: string): string {
  const source = (brief?.split("\n")[0] ?? "").trim() || command;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // unsafe → hyphen
    .replace(/^-+|-+$/g, "") // trim hyphens
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ""); // re-trim after the length cap
  return slug || "workflow";
}

/**
 * Stable dedup identity for a workflow. Same (tool, command, image) → same
 * signature → one row whose run_count increments on every repeat.
 */
export function workflowSignature(tool: string, command: string, image?: string): string {
  return createHash("sha256").update(`${tool}\0${command}\0${image ?? ""}`).digest("hex");
}
