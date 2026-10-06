/**
 * FounderOS — lookups by a role's stable short id
 * =============================================
 * Split out of job-queries.ts (over the LOC budget). The id itself is pure (tools/jobhunt/job-ref.ts); this file
 * is the two reads that need the database: id to row for `/draft j3a9f2c1`, and dedupe key to id for the alert.
 */

import { and, between, eq, inArray } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobApplications, type JobApplication } from "./schema.js";
import { idPrefixRange, shortJobId } from "../tools/jobhunt/job-ref.js";

/** More than this and the id is not an address; two rows are enough to say "ambiguous". */
export const ID_LOOKUP_LIMIT = 2;

const DEFAULT_TENANT = "turicks";

/** Rows whose uuid starts with `hexPrefix`, any candidate, any stage. Callers check the profile and stage themselves. */
export async function findApplicationsByIdPrefix(hexPrefix: string, tenantId: string = DEFAULT_TENANT): Promise<JobApplication[]> {
  const { lo, hi } = idPrefixRange(hexPrefix);
  const db = getDb();
  return db
    .select()
    .from(jobApplications)
    .where(and(eq(jobApplications.tenant_id, tenantId), between(jobApplications.id, lo, hi)))
    .limit(ID_LOOKUP_LIMIT);
}

/**
 * The short id for a set of postings, keyed by dedupe identity: what the sweep alert prints after `/draft`.
 * Replaces the brief-rank lookup there, because a rank is re-pinned on every render and an id never is.
 * Every stored row has one, so unlike a rank it is never absent for a row that exists.
 */
export async function jobIdsByDedupeKey(
  keys: readonly string[],
  opts: { tenantId?: string; profileId: string },
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({ key: jobApplications.dedupe_key, id: jobApplications.id })
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT),
        eq(jobApplications.profile_id, opts.profileId),
        inArray(jobApplications.dedupe_key, [...keys]),
      ),
    );
  return new Map(rows.map((r) => [r.key, shortJobId(r.id)] as [string, string]));
}

/** The stored rows (full id, company) for a set of postings, keyed by dedupe identity: what a 📝 Draft button needs. */
export async function jobRowsByDedupeKey(
  keys: readonly string[],
  opts: { tenantId?: string; profileId: string },
): Promise<{ key: string; id: string; company: string }[]> {
  if (keys.length === 0) return [];
  return getDb()
    .select({ key: jobApplications.dedupe_key, id: jobApplications.id, company: jobApplications.company })
    .from(jobApplications)
    .where(
      and(
        eq(jobApplications.tenant_id, opts.tenantId ?? DEFAULT_TENANT),
        eq(jobApplications.profile_id, opts.profileId),
        inArray(jobApplications.dedupe_key, [...keys]),
      ),
    );
}
