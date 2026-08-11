/**
 * scheduled_tasks lifecycle against real Postgres — the regression that migration
 * 0027 closes.
 *
 * WHAT THIS PINS. `recurrence` was declared in src/db/schema.ts and never given a
 * migration. Nothing reads or writes the column, so no feature was missing — but
 * Drizzle names EVERY schema column in the SQL it emits for `.select()` and for
 * `.returning()`, so a column that exists only in TypeScript makes every query
 * against the table fail with `column "recurrence" does not exist`. That took
 * out scheduling, boot recovery and auto-retry for nine days while the feature
 * the column belongs to had never been built.
 *
 * These tests therefore exercise the ORDINARY lifecycle — create, persist, claim,
 * reclaim — and would all have failed before 0027 for the same single reason.
 * A unit test with a mocked db cannot catch this class of bug at all: the mock
 * has no schema to disagree with.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { TENANT } from "../../src/core/config.js";
import {
  insertScheduledTask,
  claimDueScheduledTasks,
  reclaimStrandedScheduledTasks,
  listUpcomingScheduledTasks,
} from "../../src/db/queries.js";
import { getDb } from "../../src/db/client.js";
import { scheduledTasks } from "../../src/db/schema.js";

const KEY_PREFIX = `sched-recur-int-${Date.now()}`;

function task(n: number, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    prompt: `Integration task ${n}`,
    chat_id: "6775330211",
    scheduled_at: new Date(Date.now() - 60_000), // due one minute ago
    idempotency_key: `${KEY_PREFIX}:${n}`,
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(scheduledTasks).where(like(scheduledTasks.idempotency_key, `${KEY_PREFIX}%`));
}

describe("scheduled_tasks lifecycle (real Postgres)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("CREATE: inserts a task and returns the row, recurrence column included", async () => {
    // `.returning()` selects every column in the Drizzle schema. Before 0027 this
    // single call raised `column "recurrence" does not exist`.
    const row = await insertScheduledTask(task(1));

    expect(row.id).toBeTruthy();
    expect(row.status).toBe("scheduled");
    expect(row.prompt).toBe("Integration task 1");
    expect(row).toHaveProperty("recurrence");
    expect(row.recurrence).toBeNull(); // one-shot: NULL is the meaningful value
  });

  it("PERSIST: a recurrence spec round-trips through the database unchanged", async () => {
    const row = await insertScheduledTask(task(2, { recurrence: "weekly@mon:09:12" }));

    const [reread] = await getDb()
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, row.id))
      .limit(1);

    expect(reread?.recurrence).toBe("weekly@mon:09:12");
  });

  it("CREATE is idempotent on idempotency_key — a resume re-run does not double-insert", async () => {
    const first = await insertScheduledTask(task(3));
    const second = await insertScheduledTask(task(3));

    expect(second.id).toBe(first.id);
  });

  it("EXECUTE: a due task is claimed atomically, 'scheduled' → 'running', attempts+1", async () => {
    await insertScheduledTask(task(4));

    const claimed = await claimDueScheduledTasks(TENANT, new Date());
    const mine = claimed.filter((r) => r.idempotency_key === `${KEY_PREFIX}:4`);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.status).toBe("running");
    expect(mine[0]?.attempts).toBe(1);
  });

  it("EXECUTE: a task scheduled in the future is NOT claimed", async () => {
    await insertScheduledTask(task(5, { scheduled_at: new Date(Date.now() + 3_600_000) }));

    const claimed = await claimDueScheduledTasks(TENANT, new Date());

    expect(claimed.filter((r) => r.idempotency_key === `${KEY_PREFIX}:5`)).toHaveLength(0);
  });

  it("RESTART RECOVERY: a task stranded in 'running' is requeued under the attempt cap", async () => {
    await insertScheduledTask(task(6));
    await claimDueScheduledTasks(TENANT, new Date()); // now 'running', attempts = 1

    const { requeued, failed } = await reclaimStrandedScheduledTasks(TENANT, 3, new Date());

    expect(requeued.some((r) => r.idempotency_key === `${KEY_PREFIX}:6`)).toBe(true);
    expect(failed.some((r) => r.idempotency_key === `${KEY_PREFIX}:6`)).toBe(false);
    expect(requeued.find((r) => r.idempotency_key === `${KEY_PREFIX}:6`)?.status).toBe("scheduled");
  });

  it("RESTART RECOVERY: a task at the attempt cap fails loud instead of crash-looping", async () => {
    await insertScheduledTask(task(7));
    // Three claim cycles: each bumps attempts, each strand puts it back.
    for (let i = 0; i < 3; i += 1) {
      await claimDueScheduledTasks(TENANT, new Date());
      if (i < 2) await reclaimStrandedScheduledTasks(TENANT, 3, new Date());
    }

    const { failed } = await reclaimStrandedScheduledTasks(TENANT, 3, new Date());
    const mine = failed.find((r) => r.idempotency_key === `${KEY_PREFIX}:7`);

    expect(mine?.status).toBe("failed");
    expect(mine?.error).toContain("stranded");
  });

  it("LIST: a queued task appears in the founder's upcoming view", async () => {
    await insertScheduledTask(task(8, { scheduled_at: new Date(Date.now() + 600_000) }));

    const upcoming = await listUpcomingScheduledTasks(TENANT, 50);

    expect(upcoming.some((r) => r.idempotency_key === `${KEY_PREFIX}:8`)).toBe(true);
  });
});
