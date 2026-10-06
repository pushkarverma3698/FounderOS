/**
 * Provenance stored in brain_memories.metadata (jsonb) on every agent write (AG-026).
 * No column: a column is a later decision, once a query needs an index on it.
 */
import { z } from "zod";

export const BRAIN_ORIGINS = [
  "mac-claude", "mac-agy", "vps-claude", "vps-agy", "vps-daemon", "telegram", "docs", "agent",
] as const;

export const brainProvenanceSchema = z.object({
  origin: z.enum(BRAIN_ORIGINS),
  client: z.string().min(1).optional(),
  machine: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  occurred_at: z.string().datetime(),
  /** "founder": founder-only chats; "all": a group chat may see it too. */
  visibility: z.enum(["founder", "all"]),
});
export type BrainProvenance = z.infer<typeof brainProvenanceSchema>;
