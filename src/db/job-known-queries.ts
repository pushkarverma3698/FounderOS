/**
 * One batched read of the postings a profile already holds, matched on URL or
 * board id (see tools/jobhunt/known-postings.ts for why).
 *
 * Batched, not per job: a sweep carries hundreds of candidates, and one query
 * per candidate is what the title-key lookup already costs. This is
 * ceil(n / CHUNK) queries, each an indexed-by-planner `IN` list.
 */

import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "./client.js";
import { jobApplications } from "./schema.js";
import type { KnownRef } from "../tools/jobhunt/known-postings.js";

const CHUNK = 400;

export async function findKnownPostingRefs(
  urls: readonly string[],
  externalIds: readonly string[],
  tenantId: string,
  profileId: string,
): Promise<KnownRef[]> {
  const db = getDb();
  const out: KnownRef[] = [];
  const chunks = Math.max(Math.ceil(urls.length / CHUNK), Math.ceil(externalIds.length / CHUNK));
  for (let i = 0; i < chunks; i++) {
    const u = urls.slice(i * CHUNK, (i + 1) * CHUNK);
    const e = externalIds.slice(i * CHUNK, (i + 1) * CHUNK);
    const match = [u.length > 0 ? inArray(jobApplications.url, u) : undefined, e.length > 0 ? inArray(jobApplications.external_id, e) : undefined].filter(
      (c) => c !== undefined,
    );
    if (match.length === 0) continue;
    const rows = await db
      .select({ company: jobApplications.company, url: jobApplications.url, externalId: jobApplications.external_id })
      .from(jobApplications)
      .where(and(eq(jobApplications.tenant_id, tenantId), eq(jobApplications.profile_id, profileId), or(...match)));
    out.push(...rows);
  }
  return out;
}
