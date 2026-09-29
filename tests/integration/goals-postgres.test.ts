/**
 * Goals against REAL Postgres (skipped when DATABASE_URL is unreachable, like the other suites here).
 *
 * Proves what the in-memory fake cannot: that the SQL behaves. The GoalRepo contract is the very same
 * one the unit suite runs against the fake, so a divergence between the two shows up as a failure here;
 * the metric counts and the standup are then exercised over the real repository.
 *
 *   createdb -T founderos_baseline goals_dev && DATABASE_URL=postgresql://…/goals_dev pnpm setup
 *   DATABASE_URL=postgresql://…/goals_dev ALLOW_NETWORK=1 \
 *     pnpm vitest run --config vitest.integration.config.ts tests/integration/goals-postgres.test.ts
 *
 * Each test uses a tenant no other test uses and removes its own rows afterwards. That is TEST cleanup of
 * rows this file created; the product itself never deletes a goal.
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../../src/db/client.js";
import { createPgGoalRepo } from "../../src/goals/pg-repo.js";
import { createDbCounts } from "../../src/goals/metric-deps.js";
import { defineGoalRepoContract } from "../helpers/goal-repo-contract.js";

async function postgresReachable(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {}); // allow-failopen: a failed disconnect of the probe connection changes nothing
  }
}

const pgUp = await postgresReachable();
if (!pgUp) {
  // eslint-disable-next-line no-console
  console.warn("[goals-postgres] SKIP: Postgres unreachable at DATABASE_URL");
}

async function removeTenant(tenant: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`delete from agents.goal_reviews where goal_id in (select id from agents.goals where tenant_id in (${tenant}, ${`${tenant}-other`}))`);
  await db.execute(sql`delete from agents.goals where tenant_id in (${tenant}, ${`${tenant}-other`})`);
}

afterAll(async () => {
  if (pgUp) await closeDatabaseConnections();
});

describe.runIf(pgUp)("goals — real Postgres", () => {
  defineGoalRepoContract("Postgres (pg-repo.ts)", async () => {
    const tenant = `t-int-${randomUUID()}`;
    return { repo: createPgGoalRepo(getDb()), tenant, cleanup: () => removeTenant(tenant) };
  });

  describe("metric counts read the real tables", () => {
    it("counts applications for one profile in the window, and actions of one kind, inclusive at both ends", async () => {
      const db = getDb();
      const tenant = `t-int-${randomUUID()}`;
      const since = new Date("2026-09-22T09:00:00.000Z");
      const until = new Date("2026-09-29T09:00:00.000Z");
      const inside = new Date("2026-09-25T12:00:00.000Z");
      const tooOld = new Date("2026-09-22T08:59:59.000Z");
      const insertApplication = (profile: string, key: string, appliedAt: Date | null) =>
        db.execute(sql`insert into agents.job_applications (tenant_id, profile_id, dedupe_key, company, title, sponsor_verdict, salary_status, applied_at)
          values (${tenant}, ${profile}, ${`${tenant}-${key}`}, 'Acme', 'Analyst', 'sponsor', 'pass', ${appliedAt ? appliedAt.toISOString() : null}::timestamptz)`);
      try {
        await insertApplication("wife-nl-finance", "a", inside);
        await insertApplication("wife-nl-finance", "b", since); // the lower edge counts
        await insertApplication("wife-nl-finance", "c", until); // the upper edge counts
        await insertApplication("wife-nl-finance", "d", tooOld); // just outside
        await insertApplication("wife-nl-finance", "e", null); // screened, never applied
        await insertApplication("pushkar-nl-tech", "f", inside); // another candidate
        for (const [n, when] of [[1, inside], [2, inside], [3, tooOld]] as const) {
          await db.execute(sql`insert into agents.action_log (tenant_id, action, idempotency_key, created_at)
            values (${tenant}, 'goal_test_action', ${`${tenant}-act-${n}`}, ${when.toISOString()}::timestamptz)`);
        }
        const counts = createDbCounts(db, tenant);
        await expect(counts.countApplications("wife-nl-finance", since, until)).resolves.toBe(3);
        await expect(counts.countApplications("pushkar-nl-tech", since, until)).resolves.toBe(1);
        await expect(counts.countApplications("nobody", since, until)).resolves.toBe(0);
        await expect(counts.countActions("goal_test_action", since, until)).resolves.toBe(2);
        await expect(counts.countActions("no_such_action", since, until)).resolves.toBe(0);
        // Another tenant sees none of it.
        await expect(createDbCounts(db, `${tenant}-other`).countApplications("wife-nl-finance", since, until)).resolves.toBe(0);
      } finally {
        await db.execute(sql`delete from agents.job_applications where tenant_id = ${tenant}`);
        await db.execute(sql`delete from agents.action_log where tenant_id = ${tenant}`);
      }
    });
  });
});
