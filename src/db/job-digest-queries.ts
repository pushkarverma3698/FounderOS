/**
 * FounderOS - the batched-alert buffer
 * ====================================
 * Reads and writes for job_digest_state (see job-digest-schema.ts). The batching rules themselves are pure and
 * live in src/tools/jobhunt/alert-digest.ts; this file only moves rows.
 *
 * The sweep and the batch run one after the other inside one runFreeSweep call, never at the same time, so a
 * read-modify-write here cannot lose a concurrent append. `markDigestSent` clears the whole buffer for that
 * reason: everything in it was in the message that just went out.
 */

import { inArray } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobDigestState, type PendingAlerts } from "./job-digest-schema.js";

export interface StoredDigestState {
  readonly pending: PendingAlerts | null;
  readonly lastDigestAt: Date | null;
}

/** Rows for the given candidates. A candidate with no row has never buffered anything and is absent. */
export async function loadDigestStates(profileIds: readonly string[]): Promise<Map<string, StoredDigestState>> {
  if (profileIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db.select().from(jobDigestState).where(inArray(jobDigestState.profile_id, [...profileIds]));
  return new Map(rows.map((r) => [r.profile_id, { pending: r.pending ?? null, lastDigestAt: r.last_digest_at ?? null }]));
}

/** Replace one candidate buffer. Never touches `last_digest_at`: only a delivered batch moves that. */
export async function savePendingAlerts(profileId: string, pending: PendingAlerts): Promise<void> {
  const db = getDb();
  await db
    .insert(jobDigestState)
    .values({ profile_id: profileId, pending, updated_at: new Date() })
    .onConflictDoUpdate({ target: jobDigestState.profile_id, set: { pending, updated_at: new Date() } });
}

/** The batch reached the group: empty the buffer and stamp the time, in one write. */
export async function markDigestSent(profileId: string, at: Date): Promise<void> {
  const db = getDb();
  await db
    .insert(jobDigestState)
    .values({ profile_id: profileId, pending: null, last_digest_at: at, updated_at: new Date() })
    .onConflictDoUpdate({
      target: jobDigestState.profile_id,
      set: { pending: null, last_digest_at: at, updated_at: new Date() },
    });
}
