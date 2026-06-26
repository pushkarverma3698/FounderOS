/**
 * FounderOS — Asset Repository
 * =============================
 * Drizzle ORM query functions for the agent_assets table.
 * Follows the same pattern as src/db/queries.ts — named, typed, no raw SQL.
 *
 * Only S3 keys are stored here; file content never enters Postgres.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  agentAssets,
  type AgentAsset,
  type NewAgentAsset,
} from "../../db/schema.js";

/** Persist a new asset record after a successful S3 upload. Returns the UUID. */
export async function saveAsset(
  data: Omit<NewAgentAsset, "id" | "created_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(agentAssets)
    .values(data)
    .returning({ id: agentAssets.id });
  if (!row) throw new Error("saveAsset: insert returned no rows");
  return row.id;
}

/** Return all asset records for a run, ordered by creation time. */
export async function getAssetsForRun(runId: string): Promise<AgentAsset[]> {
  const db = getDb();
  return db
    .select()
    .from(agentAssets)
    .where(eq(agentAssets.run_id, runId))
    .orderBy(agentAssets.created_at);
}

/** Fetch a single asset record by UUID. Returns undefined if not found. */
export async function getAsset(assetId: string): Promise<AgentAsset | undefined> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(agentAssets)
    .where(eq(agentAssets.id, assetId));
  return row;
}

/** Delete an asset record from Postgres (does NOT delete the S3 object). */
export async function deleteAssetRecord(assetId: string): Promise<void> {
  const db = getDb();
  await db.delete(agentAssets).where(eq(agentAssets.id, assetId));
}
