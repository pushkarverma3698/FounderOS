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
    // current_priorities / next_actions / open_decisions / recent_wins were
    // removed from the compile-time seed 2026-09-28 to prevent stale June data
    // from answering "What's my focus?" on every deploy.
    expect(seedKeys).not.toContain("current_priorities");
    expect(seedKeys).not.toContain("next_actions");
    expect(seedKeys).toContain("active_projects"); // a key still managed by seed

    // Pre-existing dynamic value (no longer seeded) must survive a fill run.
    store.row = { current_priorities: FOUNDER_PRIORITIES };
    expect(await runSeed()).toBe(0);
    expect(store.row?.["current_priorities"]).toEqual(FOUNDER_PRIORITIES);
    for (const key of seedKeys) {
      expect(Object.keys(store.row ?? {})).toContain(key);
    }
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

// 2026-09-29 prod audit: the stored row still described v2 ("LangGraph JS
// (createSupervisor + createReactAgent), Gemini 2.5 Flash via OpenRouter") three
// months after v2 was deleted, plus the June priorities #760 meant to retire.
// Fill-only seeding can never correct a key that is already stored, so the bot
// described the dead architecture to the founder and wrote an Antigravity brief
// against v2's src/agents/supervisor.ts (#762 → #763, reverted).
describe("seed-founder-context — keys the code owns, and retired June values", () => {
  beforeEach(() => {
    store.row = undefined;
    store.writes = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const V2_TECH_STACK =
    "LangGraph JS (createSupervisor + createReactAgent), Gemini 2.5 Flash via OpenRouter, TypeScript 5.5 strict, Node 22 ESM, Postgres + pgvector + Drizzle ORM, grammy (Telegram), LangSmith tracing, Ollama (nomic-embed-text for turicks-brain RAG), gws (Gmail/Calendar default), direct LinkedIn API";

  it("rewrites a stored v2 system description to the current architecture", async () => {
    store.row = {
      tech_stack: V2_TECH_STACK,
      founderos_departments: "7 departments: admin (read_context, update_context), research (…)",
      last_updated: FOUNDER_UPDATED_AT,
    };

    expect(await runSeed()).toBe(0);

    const stack = String(store.row?.["tech_stack"]);
    expect(stack).not.toMatch(/createSupervisor|createReactAgent|2\.5 Flash|via OpenRouter/);
    expect(stack).toMatch(/StateGraph/);
    expect(String(store.row?.["founderos_departments"])).toMatch(/^8 kernel workers/);
    expect(store.row?.["last_updated"]).toBe(FOUNDER_UPDATED_AT);
  });

  it("removes a June seed value nobody changed, and keeps a founder-written one under the same kind of key", async () => {
    const { RETIRED_SEED_VALUES } = await import("../../../src/db/founder-context.js");
    store.row = {
      current_priorities: structuredClone(RETIRED_SEED_VALUES["current_priorities"]),
      recent_wins: structuredClone(RETIRED_SEED_VALUES["recent_wins"]),
      next_actions: ["Send the Acme SOW"],
    };

    expect(await runSeed()).toBe(0);

    expect(store.row).not.toHaveProperty("current_priorities");
    expect(store.row).not.toHaveProperty("recent_wins");
    expect(store.row?.["next_actions"]).toEqual(["Send the Acme SOW"]);
  });

  it("a second run after the correction writes nothing", async () => {
    store.row = { tech_stack: V2_TECH_STACK };
    await runSeed();
    store.writes = 0;

    await runSeed();

    expect(store.writes).toBe(0);
  });
});
