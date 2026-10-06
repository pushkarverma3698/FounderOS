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

import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../../src/db/client.js";
import { createPgGoalRepo } from "../../src/goals/pg-repo.js";
import { createDbCounts } from "../../src/goals/metric-deps.js";
import { CLAIM_LEASE_MS, runStandup, type OutgoingMessage, type StandupDeps } from "../../src/goals/standup.js";
import { defineGoalRepoContract, newGoal } from "../helpers/goal-repo-contract.js";
import { NINE_AM, TZ, makeMetricDeps } from "../helpers/goal-fixtures.js";

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

type Db = ReturnType<typeof getDb>;

/**
 * `db`, except that inside each transaction every UPDATE after the first waits for `gate`. Lets a test stop
 * a run between two statements of one transaction while it holds the first statement's row locks.
 */
function holdingSecondUpdate(db: Db, gate: Promise<void>): Db {
  const held = <T extends object>(query: T): T =>
    new Proxy(query, {
      get(target, key) {
        if (key === "then") {
          return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => gate.then(() => (target as unknown as PromiseLike<unknown>).then(ok, fail));
        }
        const v: unknown = Reflect.get(target, key);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          const out: unknown = v.apply(target, args);
          return out !== null && typeof out === "object" ? held(out) : out;
        };
      },
    });
  return new Proxy(db, {
    get(target, key) {
      const v: unknown = Reflect.get(target, key);
      if (key !== "transaction") return typeof v === "function" ? v.bind(target) : v;
      return (work: (tx: unknown) => Promise<unknown>) =>
        target.transaction(async (tx) => {
          let updates = 0;
          return work(
            new Proxy(tx, {
              get(o, k) {
                const f: unknown = Reflect.get(o, k);
                if (typeof f !== "function") return f;
                if (k !== "update") return f.bind(o);
                return (...args: unknown[]) => {
                  const builder = f.apply(o, args) as object;
                  updates += 1;
                  return updates === 1 ? builder : held(builder);
                };
              },
            }),
          );
        });
    },
  });
}

afterAll(async () => {
  if (pgUp) await closeDatabaseConnections();
});

describe.runIf(pgUp)("goals — real Postgres", () => {
  defineGoalRepoContract("Postgres (pg-repo.ts)", async () => {
    const tenant = `t-int-${randomUUID()}`;
    return { repo: createPgGoalRepo(getDb()), tenant, cleanup: () => removeTenant(tenant) };
  });

  describe("the standup over the real repository: exactly once, and crash-safe, with real timestamps", () => {
    async function setup() {
      const tenant = `t-int-${randomUUID()}`;
      const repo = createPgGoalRepo(getDb());
      const clock = { t: NINE_AM.getTime() };
      const sent: OutgoingMessage[] = [];
      const metrics = makeMetricDeps();
      const skipped: string[] = [];
      const deps: StandupDeps = {
        repo,
        metrics,
        tenant,
        timeZone: TZ,
        leaseMs: CLAIM_LEASE_MS,
        metricTimeoutMs: 1000,
        sendTimeoutMs: 1000,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date(clock.t),
        readHalt: async () => null,
        skips: { record: async (d) => void skipped.push(d), take: async () => [] },
        send: async (m) => void sent.push(m),
      };
      const created = new Date("2026-09-01T08:00:00.000Z");
      const apps = await repo.addGoal(tenant, newGoal({ title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 5, due_on: "2026-10-31" }), created);
      const manual = await repo.addGoal(tenant, newGoal({ title: "Reach 5k", metric_key: "manual", target: 5000 }), new Date(created.getTime() + 1000));
      await repo.recordManualValue(tenant, manual.id, 5200, new Date("2026-09-28T10:00:00.000Z"));
      return { tenant, repo, clock, sent, metrics, deps, apps, manual, skipped };
    }

    it("sends one message, marks both rows sent, closes the finished goal in the same step, and sends nothing on a second run", async () => {
      const t = await setup();
      try {
        const out = await runStandup(t.deps);
        expect(out).toMatchObject({ kind: "sent", messages: 1, goals: 2, done: ["Reach 5k"] });
        expect(t.sent).toHaveLength(1);
        expect(t.sent[0]!.text).toContain("1. Tashi applies: 0 of 5 (need 5 more by 31 Oct, pace BEHIND)");
        expect(t.sent[0]!.text).toContain("✅ 2. Reach 5k: reached 5,200 of 5,000");
        expect((await t.repo.getGoal(t.tenant, t.manual.id))!.status).toBe("done");
        expect(await t.repo.hasSentReview(t.tenant, "2026-09-29")).toBe(true);
        expect((await t.repo.recentReviews(t.apps.id, 1))[0]).toMatchObject({ review_date: "2026-09-29", value: 0, pace: "behind", attempts: 1 });

        expect((await runStandup(t.deps)).kind).toBe("already-sent");
        expect(t.sent).toHaveLength(1);
      } finally {
        await removeTenant(t.tenant);
      }
    });

    it("two runs started together produce ONE message", async () => {
      const t = await setup();
      try {
        const [a, b] = await Promise.all([runStandup(t.deps), runStandup(t.deps)]);
        expect([a.kind, b.kind].sort()).toEqual(["in-progress", "sent"]);
        expect(t.sent).toHaveLength(1);
      } finally {
        await removeTenant(t.tenant);
      }
    });

    // CI 2026-10-05 (PR #909): `deadlock detected` between one run's claim INSERT and the other run's
    // saveReviewResults UPDATE. The claim locks review rows in goal-id order (ON CONFLICT DO UPDATE locks a
    // row even when its WHERE refuses it); the save locked the same rows in priority order. Random uuids made
    // the orders disagree about half the time, and the second claim had to land in the gap between the two
    // UPDATEs. Here both are forced: the first-priority goal gets the larger id, and the first run's second
    // UPDATE is held until the second run's claim is blocked on a lock (or has already finished).
    it("a second run claiming while the first stores its results does not deadlock", async () => {
      const t = await setup();
      let releaseFirst = (): void => undefined;
      let both: Promise<unknown> = Promise.resolve();
      try {
        const tail = randomUUID().slice(8);
        await getDb().execute(sql`update agents.goals set id = ${`ffffffff${tail}`}::uuid where id = ${t.apps.id}::uuid`);
        await getDb().execute(sql`update agents.goals set id = ${`00000000${tail}`}::uuid where id = ${t.manual.id}::uuid`);

        const secondIsBlocked = new Promise<void>((resolve) => (releaseFirst = resolve));
        let saveStarted!: () => void;
        const firstIsSaving = new Promise<void>((resolve) => (saveStarted = resolve));
        let secondClaimed = false;

        const firstRepo = createPgGoalRepo(holdingSecondUpdate(getDb(), secondIsBlocked));
        const first: StandupDeps = {
          ...t.deps,
          repo: {
            ...firstRepo,
            saveReviewResults: (date, results) => {
              const p = firstRepo.saveReviewResults(date, results);
              saveStarted();
              return p;
            },
          },
        };
        const second: StandupDeps = {
          ...t.deps,
          repo: {
            ...t.repo,
            claimReviews: async (...args) => {
              await firstIsSaving;
              const out = await t.repo.claimReviews(...args);
              secondClaimed = true;
              return out;
            },
          },
        };

        const runs = Promise.all([runStandup(first), runStandup(second)]);
        both = runs;
        await firstIsSaving;
        await vi.waitFor(async () => {
          if (secondClaimed) return;
          const waiting = await getDb().execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and (query ilike '%goal_reviews%' or query ilike '%pg_advisory_xact_lock%')`,
          );
          expect(waiting.length).toBeGreaterThan(0);
        });
        releaseFirst();

        const [a, b] = await runs;
        expect(a.kind).toBe("sent");
        expect(["in-progress", "already-sent"]).toContain(b.kind);
        expect(t.sent).toHaveLength(1);
      } finally {
        // Never leave the first run parked inside its transaction: it holds the day's lock.
        releaseFirst();
        await both.catch(() => undefined); // allow-failopen: the assertions above already reported any failure
        await removeTenant(t.tenant);
      }
    });

    it("a run that died after claiming is retaken once the lease has expired, and only then", async () => {
      const t = await setup();
      try {
        // The first run claims and then dies before it stores or sends anything.
        const dying: StandupDeps = { ...t.deps, repo: { ...t.repo, saveReviewResults: () => new Promise(() => undefined) } };
        void runStandup(dying);
        await vi.waitFor(async () => expect((await t.repo.claimReviews(t.tenant, [t.apps.id], "2026-09-29", NINE_AM, CLAIM_LEASE_MS)).leased).toHaveLength(1));
        expect(t.sent).toEqual([]);

        t.clock.t += 60_000;
        const early = await runStandup(t.deps);
        expect(early).toMatchObject({ kind: "in-progress" });
        expect(t.sent).toEqual([]);

        t.clock.t += CLAIM_LEASE_MS; // now past claimed_at + lease
        const next = await runStandup(t.deps);
        expect(next.kind).toBe("sent");
        expect(t.sent).toHaveLength(1);
        expect((await t.repo.recentReviews(t.apps.id, 1))[0]).toMatchObject({ attempts: 2 });
        expect((await runStandup(t.deps)).kind).toBe("already-sent");
      } finally {
        await removeTenant(t.tenant);
      }
    });

    it("keys the review on the local date: 23:30 UTC is already 30 Sep in Amsterdam, and 09:00 the next morning is the same local day", async () => {
      const t = await setup();
      try {
        t.clock.t = Date.parse("2026-09-29T23:30:00Z");
        await runStandup(t.deps);
        expect((await t.repo.recentReviews(t.apps.id, 1))[0]!.review_date).toBe("2026-09-30");
        t.clock.t = Date.parse("2026-09-30T07:00:00Z");
        expect((await runStandup(t.deps)).kind).toBe("already-sent");
        expect(t.sent).toHaveLength(1);
      } finally {
        await removeTenant(t.tenant);
      }
    });
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
