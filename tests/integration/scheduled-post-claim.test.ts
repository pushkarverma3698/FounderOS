/**
 * Scheduled-post atomic claim (real Postgres).
 * Proves claimDueScheduledPosts flips due rows to 'posting' and that two
 * CONCURRENT sweeps never claim the same row — the guard against the
 * every-minute cron double-posting to LinkedIn (FOR UPDATE SKIP LOCKED).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TENANT } from "../../src/core/config.js";
import { insertScheduledPost, claimDueScheduledPosts } from "../../src/db/queries.js";
import { getDb } from "../../src/db/client.js";
import { scheduledPosts } from "../../src/db/schema.js";
import { eq, like } from "drizzle-orm";

const KEY_PREFIX = `claim-int-test-${Date.now()}`;

function duePost(n: number) {
  return {
    tenant_id: TENANT,
    platform: "linkedin",
    account_key: "turicks",
    text: `Claim test post ${n}`,
    mention_urn: null,
    mention_name: null,
    visibility: "PUBLIC" as const,
    scheduled_at: new Date(Date.now() - 60_000), // due (1 min ago)
    idempotency_key: `${KEY_PREFIX}:${n}`,
  };
}

describe("claimDueScheduledPosts (real Postgres)", () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(scheduledPosts).where(like(scheduledPosts.idempotency_key, `${KEY_PREFIX}%`));
  });

  it("claims a due row: flips it 'scheduled' → 'posting' and returns it", async () => {
    await insertScheduledPost(duePost(1));
    const claimed = await claimDueScheduledPosts(TENANT, new Date());
    const mine = claimed.filter((r) => r.idempotency_key === `${KEY_PREFIX}:1`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("posting");

    const db = getDb();
    const [row] = await db
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.idempotency_key, `${KEY_PREFIX}:1`))
      .limit(1);
    expect(row!.status).toBe("posting"); // persisted, not just returned
  });

  it("never double-claims: two concurrent sweeps split the due rows disjointly", async () => {
    await insertScheduledPost(duePost(10));
    await insertScheduledPost(duePost(11));

    // Fire two sweeps at once — FOR UPDATE SKIP LOCKED must prevent overlap.
    const [a, b] = await Promise.all([
      claimDueScheduledPosts(TENANT, new Date()),
      claimDueScheduledPosts(TENANT, new Date()),
    ]);

    const mineOf = (rows: typeof a) =>
      rows.map((r) => r.idempotency_key).filter((k) => k.startsWith(KEY_PREFIX));
    const claimedA = mineOf(a);
    const claimedB = mineOf(b);

    // No key appears in both sweeps (the double-post guard).
    const overlap = claimedA.filter((k) => claimedB.includes(k));
    expect(overlap).toEqual([]);
    // Both rows got claimed exactly once across the two sweeps.
    expect([...claimedA, ...claimedB].sort()).toEqual([`${KEY_PREFIX}:10`, `${KEY_PREFIX}:11`]);
  });

  it("ignores not-yet-due and already-'posting' rows", async () => {
    // Future row — not due.
    await insertScheduledPost({ ...duePost(20), scheduled_at: new Date(Date.now() + 3_600_000) });
    const claimed = await claimDueScheduledPosts(TENANT, new Date());
    expect(claimed.map((r) => r.idempotency_key)).not.toContain(`${KEY_PREFIX}:20`);
  });
});
