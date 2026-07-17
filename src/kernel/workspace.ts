/**
 * FounderOS v3 kernel — workspace handoff contract (spec 2026-07-14 §3.2, item 10).
 * ==================================================================================
 * A WorkspaceHandle names WHERE an agent's files live for one run: the sandbox
 * directory (ephemeral) and the S3 prefix (durable). Handoff between steps is
 * always by-reference through S3 keys carried in validated StepResults — never
 * via a shared mutable directory (the filesystem analogue of envelope-only
 * worker context).
 *
 * Lives in its own file because contracts.ts sits at the 400-line budget;
 * re-exported through the kernel barrel like every other contract.
 */

import { z } from "zod";

/**
 * run_id doubles as a path segment on the VPS and an S3 key segment, so its
 * grammar is the security boundary against path traversal: lowercase
 * alphanumerics and inner hyphens only, 4–64 chars, no dots or slashes ever.
 */
export const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/;

export const WORKSPACE_KINDS = ["mac-projects", "vps-docker"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const WorkspaceHandleSchema = z.object({
  run_id: z.string().regex(RUN_ID_RE, "run_id: lowercase alphanumerics/hyphens, 4-64 chars"),
  kind: z.enum(WORKSPACE_KINDS),
  /** Absolute path of the sandbox work dir (inside the container for vps-docker). */
  local_dir: z.string().min(1),
  /** Durable home of the run's artifacts, e.g. "agent-runs/{run_id}". */
  s3_prefix: z.string().min(1),
  /** Sandbox TTL — the S3 objects outlive it. */
  expires_at: z.string().datetime(),
});
export type WorkspaceHandle = z.infer<typeof WorkspaceHandleSchema>;
