/**
 * Mac worker lease against REAL Postgres (skipped when DATABASE_URL is unreachable, like the other suites here). The unit
 * suites mock the database, so only this can show that two overlapping leases never get the same row.
 *
 *   DATABASE_URL=postgresql://…/founderos_test_macworker TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=1 GEMINI_API_KEY=x ALLOW_NETWORK=1 \
 *     pnpm vitest run --config vitest.integration.config.ts tests/integration/mac-worker-lease-postgres.test.ts
 *
 * Rows use a dedupe key prefix no other test uses and are deleted afterwards: TEST cleanup of rows this file created.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { eq, like } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../../src/db/client.js";
import { jobApplications } from "../../src/db/schema.js";
import { TENANT } from "../../src/core/config.js";
import { extendLease, getLastMacBeat, getLeasedRow, leaseNextRow, markUnconfirmed, recordMacBeat, releaseLease, releaseWithoutAttempt } from "../../src/db/mac-worker-queries.js";

async function postgresReachable(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1 FROM agents.mac_worker_beat LIMIT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {}); // allow-failopen: a failed disconnect of the probe connection changes nothing
  }
}

const up = await postgresReachable();
const PROFILE = "macworker-test-profile";
const PREFIX = `macworker-test-${randomUUID()}-`;
const NOW = new Date();
const TTL = 30 * 60 * 1000;
const CAPTCHA = "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it";

async function clean(): Promise<void> {
  await getDb().delete(jobApplications).where(like(jobApplications.dedupe_key, "macworker-test-%"));
}

let companySeq = 0;
async function seed(n: number, over: Partial<typeof jobApplications.$inferInsert> = {}): Promise<string[]> {
  const rows = await getDb()
    .insert(jobApplications)
    .values(
      Array.from({ length: n }, (_, i) => ({
        tenant_id: TENANT, dedupe_key: `${PREFIX}${randomUUID()}`, company: `Co ${companySeq++}-${i}`, title: "Engineer",
        sponsor_verdict: "unknown", salary_status: "unknown", profile_id: PROFILE, apply_lane: "hand_off",
        apply_lane_reason: CAPTCHA, apply_lane_at: new Date(NOW.getTime() - 1000 * (n - i)), ...over,
      })),
    )
    .returning({ id: jobApplications.id });
  return rows.map((r) => r.id);
}

describe.skipIf(!up)("Mac worker lease (real Postgres)", () => {
  beforeAll(clean);
  afterAll(async () => {
    await clean();
    await closeDatabaseConnections();
  });

  it("20 concurrent leases over 5 eligible rows hand out 5 distinct rows and 15 nulls", async () => {
    const ids = await seed(5);
    const got = await Promise.all(Array.from({ length: 20 }, () => leaseNextRow([PROFILE], NOW, randomUUID(), TTL)));
    const leased = got.filter((r) => r !== null).map((r) => r!.id);
    expect(leased).toHaveLength(5);
    expect(new Set(leased).size).toBe(5);
    expect([...leased].sort()).toEqual([...ids].sort());
    await clean();
  });

  it("two concurrent leases on one eligible row: exactly one wins, every time", async () => {
    for (let i = 0; i < 10; i++) {
      await seed(1);
      const [a, b] = await Promise.all([leaseNextRow([PROFILE], NOW, "lease-a", TTL), leaseNextRow([PROFILE], NOW, "lease-b", TTL)]);
      expect([a, b].filter((r) => r !== null)).toHaveLength(1);
      await clean();
    }
  });

  it("only leases what is eligible, and respects a live lease, a lapsed lease and the attempt cap", async () => {
    const [good] = await seed(1);
    await seed(1, { apply_lane_reason: "Workday: needs an account" });
    await seed(1, { applied_at: NOW });
    await seed(1, { skipped_at: NOW });
    await seed(1, { liveness: "expired" });
    await seed(1, { profile_id: "someone-else" });
    await seed(1, { apply_lane: "auto" });
    await seed(1, { apply_lane_at: new Date(NOW.getTime() - 49 * 3600 * 1000) });
    await seed(1, { mac_attempts: 3 });
    // held past `later` below: a lease that lapsed there would tie with `good` on apply_lane_at and either could win
    await seed(1, { mac_lease_id: "held", mac_lease_until: new Date(NOW.getTime() + 3 * TTL) });
    const row = await leaseNextRow([PROFILE], NOW, "lease-x", TTL);
    expect(row?.id).toBe(good);
    expect(row?.mac_attempts).toBe(1);
    expect(row?.mac_lease_until?.getTime()).toBe(NOW.getTime() + TTL);
    expect(await leaseNextRow([PROFILE], NOW, "lease-y", TTL)).toBeNull();
    expect(await leaseNextRow([], NOW, "lease-z", TTL)).toBeNull();
    const later = new Date(NOW.getTime() + TTL + 1000);
    const again = await leaseNextRow([PROFILE], later, "lease-later", TTL);
    expect(again?.id).toBe(good);
    expect(again?.mac_attempts).toBe(2);
    await clean();
  });

  it("extend, release and the lease check only work for the lease that holds the row", async () => {
    const [id] = await seed(1);
    await leaseNextRow([PROFILE], NOW, "lease-1", TTL);
    expect(await getLeasedRow(id!, "lease-1")).not.toBeNull();
    expect(await getLeasedRow(id!, "lease-2")).toBeNull();
    const until = new Date(NOW.getTime() + 2 * TTL);
    expect(await extendLease(id!, "lease-2", until, "challenge", NOW)).toBe(false);
    expect(await extendLease(id!, "lease-1", until, "challenge", NOW)).toBe(true);
    expect((await getLeasedRow(id!, "lease-1"))?.mac_lease_until?.getTime()).toBe(until.getTime());
    expect(await releaseLease(id!, "lease-2", "failed: x", NOW)).toBe(false);
    expect(await releaseLease(id!, "lease-1", "failed: form changed", NOW)).toBe(true);
    expect(await getLeasedRow(id!, "lease-1")).toBeNull();
    const again = await leaseNextRow([PROFILE], NOW, "lease-3", TTL);
    expect(again?.id).toBe(id);
    expect(again?.mac_result).toBe("failed: form changed");
    await clean();
  });

  it("an unconfirmed result closes the row: the lease query never returns it again, even after the lease would lapse", async () => {
    const [id] = await seed(1);
    await leaseNextRow([PROFILE], NOW, "lease-u", TTL);
    expect(await markUnconfirmed(id!, "lease-other", "no banner", NOW)).toBe(false);
    expect(await markUnconfirmed(id!, "lease-u", "no banner", NOW)).toBe(true);
    const later = new Date(NOW.getTime() + 10 * TTL);
    expect(await leaseNextRow([PROFILE], later, "lease-again", TTL)).toBeNull();
    await clean();
  });

  it("a dry-run release spends no attempt: the same row can be dry-run again and again", async () => {
    const [id] = await seed(1);
    for (let i = 0; i < 5; i++) {
      const row = await leaseNextRow([PROFILE], NOW, `lease-d${i}`, TTL);
      expect(row?.id).toBe(id);
      expect(row?.mac_attempts).toBe(1);
      expect(await releaseWithoutAttempt(id!, `lease-d${i}`, "dry run: ok", NOW)).toBe(true);
    }
    await clean();
  });

  it("the 30-day company cooldown: a company applied to (or unconfirmed) within 30 days is never leased", async () => {
    const [cooledApplied] = await seed(1, { company: "Acme B.V." });
    await seed(1, { company: "Acme", applied_at: new Date(NOW.getTime() - 5 * 24 * 3600 * 1000), stage: "applied" });
    const [cooledUnconfirmed] = await seed(1, { company: "Globex Ltd" });
    await seed(1, { company: "Globex", mac_result: "unconfirmed: no banner", mac_result_at: new Date(NOW.getTime() - 3600 * 1000), mac_attempts: 3 });
    const [free] = await seed(1, { company: "Initech" });
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await leaseNextRow([PROFILE], NOW, `lease-c${i}`, TTL);
      if (r) got.push(r.id);
    }
    expect(got).toEqual([free]);
    expect(got).not.toContain(cooledApplied);
    expect(got).not.toContain(cooledUnconfirmed);
    await clean();
  });

  it("skip: a row the caller rejects (open required question) is never leased and spends no attempt", async () => {
    const [open, fine] = await seed(2);
    const got = await leaseNextRow([PROFILE], NOW, "lease-s1", TTL, (id) => id === open);
    expect(got?.id).toBe(fine);
    expect(await leaseNextRow([PROFILE], NOW, "lease-s2", TTL, (id) => id === open)).toBeNull();
    const rows = await getDb().select({ attempts: jobApplications.mac_attempts }).from(jobApplications).where(eq(jobApplications.id, open!));
    expect(rows[0]?.attempts).toBe(0);
    await clean();
  });

  it("records and reads the Mac heartbeat", async () => {
    const at = new Date(NOW.getTime() - 5000);
    await recordMacBeat(at);
    expect((await getLastMacBeat())?.getTime()).toBe(at.getTime());
    await recordMacBeat(NOW);
    expect((await getLastMacBeat())?.getTime()).toBe(NOW.getTime());
  });
});
