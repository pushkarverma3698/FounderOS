/**
 * Claude hand-off lane lease against REAL Postgres (skipped when DATABASE_URL is unreachable). Shows what the mocked unit
 * suites cannot: two overlapping leases never get the same row, and the Claude lane and the Mac TS worker never open the
 * same row.
 *
 *   DATABASE_URL=postgresql://…/founderos_test_claudelane TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=1 GEMINI_API_KEY=x ALLOW_NETWORK=1 \
 *     pnpm vitest run --config vitest.integration.config.ts tests/integration/claude-lane-lease-postgres.test.ts
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
import { leaseClaudeRows, listClaudeFilledRows, listFilledForLease, markFilled } from "../../src/db/claude-lane-queries.js";
import { leaseNextRow, releaseLease } from "../../src/db/mac-worker-queries.js";

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
const PROFILE = "claudelane-test-profile";
const PREFIX = `claudelane-test-${randomUUID()}-`;
const NOW = new Date();
const TTL = 30 * 60 * 1000;
const WIZARD = "Form not usable: multi-step wizard, next page never reached";
const CAPTCHA = "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it";
const WORKDAY = "Workday: Workday requires per-company account creation and multi-step login";
const opts = (over: Partial<{ leaseId: string; max: number; workday: boolean }> = {}) => ({ now: NOW, leaseId: randomUUID(), ttlMs: TTL, max: 10, workday: false, ...over });

async function clean(): Promise<void> {
  await getDb().delete(jobApplications).where(like(jobApplications.dedupe_key, "claudelane-test-%"));
}

let seq = 0;
async function seed(n: number, over: Partial<typeof jobApplications.$inferInsert> = {}): Promise<string[]> {
  const rows = await getDb()
    .insert(jobApplications)
    .values(
      Array.from({ length: n }, (_, i) => ({
        tenant_id: TENANT, dedupe_key: `${PREFIX}${randomUUID()}`, company: `Co ${seq++}-${i}`, title: "Engineer",
        sponsor_verdict: "unknown", salary_status: "unknown", profile_id: PROFILE, apply_lane: "hand_off",
        apply_lane_reason: WIZARD, apply_lane_at: new Date(NOW.getTime() - 1000 * (n - i)), ...over,
      })),
    )
    .returning({ id: jobApplications.id });
  return rows.map((r) => r.id);
}

describe.skipIf(!up)("Claude hand-off lane lease (real Postgres)", () => {
  beforeAll(clean);
  afterAll(async () => {
    await clean();
    await closeDatabaseConnections();
  });

  it("12 eligible rows: one call returns 10, the next the other 2, never the same row twice", async () => {
    const ids = await seed(12);
    const a = await leaseClaudeRows([PROFILE], opts());
    const b = await leaseClaudeRows([PROFILE], opts());
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(2);
    const all = [...a, ...b].map((r) => r.id);
    expect(new Set(all).size).toBe(12);
    expect([...all].sort()).toEqual([...ids].sort());
    expect(a.every((r) => r.mac_attempts === 1)).toBe(true);
    await clean();
  });

  it("20 concurrent lease calls over 5 rows hand out each row exactly once", async () => {
    const ids = await seed(5);
    const got = await Promise.all(Array.from({ length: 20 }, () => leaseClaudeRows([PROFILE], opts({ max: 3 }))));
    const leased = got.flat().map((r) => r.id);
    expect(leased).toHaveLength(5);
    expect([...leased].sort()).toEqual([...ids].sort());
    await clean();
  });

  it("the Claude lane and the Mac TS worker never open the same row, even run together", async () => {
    const claudeIds = await seed(3);
    const macIds = await seed(3, { apply_lane_reason: CAPTCHA });
    const [claude, ...mac] = await Promise.all([
      leaseClaudeRows([PROFILE], opts()),
      ...Array.from({ length: 6 }, () => leaseNextRow([PROFILE], NOW, randomUUID(), TTL)),
    ]);
    const macLeased = mac.filter((r) => r !== null).map((r) => r!.id);
    expect(claude.map((r) => r.id).sort()).toEqual([...claudeIds].sort());
    expect(macLeased.sort()).toEqual([...macIds].sort());
    await clean();
  });

  it("Workday rows are leased only with the flag; bot checks and aggregators never", async () => {
    await seed(1, { apply_lane_reason: WORKDAY });
    await seed(1, { apply_lane_reason: "Form not usable: Jobicy is an aggregator page without an embedded application form" });
    await seed(1, { apply_lane: "needs_you" });
    await seed(1, { apply_lane_reason: CAPTCHA });
    expect(await leaseClaudeRows([PROFILE], opts())).toHaveLength(0); // no Workday flag, an aggregator, needs_you, a CAPTCHA
    await clean();
    const [wd2] = await seed(1, { apply_lane_reason: WORKDAY });
    expect(await leaseClaudeRows([PROFILE], opts())).toHaveLength(0);
    const on = await leaseClaudeRows([PROFILE], opts({ workday: true }));
    expect(on.map((r) => r.id)).toEqual([wd2]);
    await clean();
  });

  it("skips applied, skipped, expired, stale, max-attempt and live-leased rows, and one company twice in a call", async () => {
    await seed(1, { applied_at: NOW });
    await seed(1, { skipped_at: NOW });
    await seed(1, { liveness: "expired" });
    await seed(1, { apply_lane_at: new Date(NOW.getTime() - 72 * 3600 * 1000) });
    await seed(1, { mac_attempts: 3 });
    await seed(1, { mac_lease_id: "someone", mac_lease_until: new Date(NOW.getTime() + 60_000) });
    expect(await leaseClaudeRows([PROFILE], opts())).toHaveLength(0);
    await seed(2, { company: "Same Company" });
    expect(await leaseClaudeRows([PROFILE], opts())).toHaveLength(1);
    await clean();
  });

  it("filled_to_submit holds the row for 12h, is listed, and is not applied; a lapsed re-lease clears the stale result", async () => {
    const [id] = await seed(1);
    const leaseId = randomUUID();
    const [leased] = await leaseClaudeRows([PROFILE], opts({ leaseId }));
    expect(leased?.id).toBe(id);
    const until = new Date(NOW.getTime() + 12 * 3600 * 1000);
    expect(await markFilled(id!, leaseId, { link: "https://careers.example.test/submit", blanks: ["Visa"] }, until, NOW)).toBe(true);
    expect(await markFilled(id!, "other-lease", { link: "https://x.test", blanks: [] }, until, NOW)).toBe(false);
    expect(await leaseClaudeRows([PROFILE], opts())).toHaveLength(0); // held: the lease is live
    const listed = await listClaudeFilledRows(PROFILE);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ rowId: id, link: "https://careers.example.test/submit", blanks: ["Visa"] });
    expect(await listFilledForLease(leaseId)).toHaveLength(1);
    const [row] = await getDb().select().from(jobApplications).where(eq(jobApplications.id, id!));
    expect(row?.applied_at).toBeNull();
    expect(row?.stage).not.toBe("applied");
    // the lease lapses: another run may take the row again, and the old filled result is cleared
    const later = new Date(until.getTime() + 1000);
    const again = await leaseClaudeRows([PROFILE], { ...opts(), now: later });
    expect(again).toHaveLength(1);
    expect(again[0]?.mac_result).toBeNull();
    expect(await listClaudeFilledRows(PROFILE)).toHaveLength(0);
    await releaseLease(id!, again[0]!.mac_lease_id!, "failed: test", later);
    await clean();
  });
});
