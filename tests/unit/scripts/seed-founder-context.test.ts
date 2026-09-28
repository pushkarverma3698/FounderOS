/**
 * The deploy seed must never overwrite the founder's own context.
 * ================================================================
 * deploy/deploy.sh (and scripts/vps-prod-stabilize.sh) run
 * scripts/seed-founder-context.ts on EVERY deploy. It used to write through
 * upsertFounderContext, which merges `{ ...current, ...seed }`, so the
 * hand-written June seed replaced whatever the founder had saved through
 * update_context. "What's my focus?" (the /start example) was then answered
 * from June data after every deploy.
 *
 * These tests run the real script against an in-memory founder_context row
 * (the Drizzle client is faked; getFounderContext / the seed write are real).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  writes: 0,
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (store.row ? [{ data: structuredClone(store.row) }] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (v: { data: Record<string, unknown> }) => ({
        onConflictDoUpdate: async ({ set }: { set: { data: Record<string, unknown> } }) => {
          store.writes++;
          store.row = structuredClone(store.row ? set.data : v.data);
        },
      }),
    }),
  }),
}));

/** Run scripts/seed-founder-context.ts once, the way deploy.sh does. Returns its exit code. */
async function runSeed(): Promise<unknown> {
  vi.resetModules();
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await import("../../../scripts/seed-founder-context.js");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  const code = exit.mock.calls[0]?.[0];
  exit.mockRestore();
  return code;
}

const FOUNDER_PRIORITIES = ["Close the Acme pilot this week"];
const FOUNDER_UPDATED_AT = "2026-09-27T09:15:00.000Z";

describe("seed-founder-context — fill-only", () => {
  beforeEach(() => {
    store.row = undefined;
    store.writes = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a founder-set current_priorities survives a seed run", async () => {
    store.row = {
      current_priorities: FOUNDER_PRIORITIES,
      next_actions: ["Send the Acme SOW"],
      last_updated: FOUNDER_UPDATED_AT,
    };

    expect(await runSeed()).toBe(0);

    expect(store.row?.["current_priorities"]).toEqual(FOUNDER_PRIORITIES);
    expect(store.row?.["next_actions"]).toEqual(["Send the Acme SOW"]);
    // A deploy is not a founder update: stale seed data must not look fresh.
    expect(store.row?.["last_updated"]).toBe(FOUNDER_UPDATED_AT);
  });

  it("fills only the keys that are absent", async () => {
    // Empty DB: the seed creates the row with every seed key.
    expect(await runSeed()).toBe(0);
    const seedKeys = Object.keys(store.row ?? {}).sort();
    expect(seedKeys).toContain("current_priorities");

    store.row = { current_priorities: FOUNDER_PRIORITIES };
    expect(await runSeed()).toBe(0);

    expect(Object.keys(store.row ?? {}).sort()).toEqual(seedKeys);
    expect(store.row?.["current_priorities"]).toEqual(FOUNDER_PRIORITIES);
  });

  it("writes nothing when every seed key is already stored", async () => {
    await runSeed();
    const before = structuredClone(store.row);
    store.writes = 0;

    expect(await runSeed()).toBe(0);

    expect(store.writes).toBe(0);
    expect(store.row).toEqual(before);
  });

  it("leaves internal bookkeeping keys untouched", async () => {
    const alerts = { date: "2026-09-28", levels: [80] };
    store.row = { current_priorities: FOUNDER_PRIORITIES, budget_alerts_sent: alerts };

    await runSeed();

    expect(store.row?.["budget_alerts_sent"]).toEqual(alerts);
  });
});
