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
import { readFileSync } from "node:fs";
import { CONTEXT_META_KEY } from "../../../src/db/context-meta.js";
import { RETIRED_SEED_VALUES, SYSTEM_CONTEXT_KEYS, isRetiredSeedValue } from "../../../src/db/founder-context.js";
import { DEPARTMENT_TOOLS, buildDepartmentsSummary } from "../../../src/agents/capabilities.js";

const PROD_ROW = JSON.parse(
  readFileSync(new URL("../../fixtures/founder-context-prod-2026-09-29.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** The four June seed values the 2026-09-29 prod row still holds. */
const JUNE_KEYS = ["current_focus", "active_projects", "proof_gallery", "portfolio_signal"] as const;
/** 11:00 IST on the day the fix deploys. */
const DEPLOY_AT = new Date("2026-09-30T05:30:00.000Z");

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
    // current_focus / active_projects / proof_gallery / portfolio_signal followed
    // them out on 2026-09-29: the founder's own facts, and the model quoted June's
    // copy of them as current. He sets them with /focus and /projects.
    for (const key of JUNE_KEYS) expect(seedKeys).not.toContain(key);
    expect(seedKeys).toContain("turicks_pricing"); // a key still managed by seed

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
    const departments = String(store.row?.["founderos_departments"]);
    expect(departments).toMatch(/^8 kernel workers/);
    for (const dept of Object.keys(DEPARTMENT_TOOLS)) expect(departments).toContain(`${dept} (`);
    expect(store.row?.["last_updated"]).toBe(FOUNDER_UPDATED_AT);
  });

  it("removes a June seed value nobody changed, and keeps a founder-written one under the same kind of key", async () => {
    const { RETIRED_SEED_VALUES } = await import("../../../src/db/founder-context.js");
    store.row = {
      current_priorities: structuredClone(RETIRED_SEED_VALUES["current_priorities"]?.[0]),
      recent_wins: structuredClone(RETIRED_SEED_VALUES["recent_wins"]?.[0]),
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

// 2026-09-29 prod audit: "what is my current focus?" was answered with June's
// "Phase D-Bis: 3 proof showcases…". Fill-only seeding wrote current_focus,
// active_projects, proof_gallery ("IP fallback: http://YOUR_VPS_IP/showcase-1/")
// and portfolio_signal once, and nothing ever corrected them. They leave the seed,
// and a stored copy still equal to what the seed wrote is removed on deploy.
describe("seed-founder-context — the 2026-09-29 prod row", () => {
  let logs: () => string;

  beforeEach(() => {
    store.row = structuredClone(PROD_ROW);
    store.writes = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DEPLOY_AT);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logs = () => spy.mock.calls.map((c) => c.join(" ")).join("\n");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const meta = (): Record<string, { at: string; source: string }> =>
    (store.row?.[CONTEXT_META_KEY] ?? {}) as Record<string, { at: string; source: string }>;

  it("removes the four June values nobody changed, and says so in the deploy log", async () => {
    expect(await runSeed()).toBe(0);

    for (const key of JUNE_KEYS) expect(store.row, key).not.toHaveProperty(key);
    expect(logs()).toContain("Removed 4 retired June seed value(s)");
    for (const key of JUNE_KEYS) expect(logs()).toContain(key);
  });

  it("keeps every other value, last_updated and the budget state exactly as they were", async () => {
    await runSeed();

    const kept = Object.keys(PROD_ROW).filter((k) => !(JUNE_KEYS as readonly string[]).includes(k) && k !== "founderos_departments");
    for (const key of kept) expect(store.row?.[key], key).toEqual(PROD_ROW[key]);
    expect(store.row?.["last_updated"]).toBe("2026-09-28T13:19:27Z");
  });

  // founderos_departments was a hand-written paragraph; it is now generated from the tool registry, so the first deploy
  // after that change rewrites the stored copy once, and says so.
  it("rewrites the hand-written departments paragraph with the generated one, once", async () => {
    await runSeed();

    expect(store.row?.["founderos_departments"]).toBe(buildDepartmentsSummary());
    expect(store.row?.["founderos_departments"]).not.toEqual(PROD_ROW["founderos_departments"]);
    expect(logs()).toContain("Rewrote 1 system key(s) the code owns: founderos_departments");
  });

  it("gives the three code-owned keys their first date and leaves every founder fact undated", async () => {
    await runSeed();

    expect(Object.keys(meta()).sort()).toEqual([...SYSTEM_CONTEXT_KEYS].sort());
    for (const key of SYSTEM_CONTEXT_KEYS) expect(meta()[key]).toEqual({ at: DEPLOY_AT.toISOString(), source: "system" });
    expect(logs()).toMatch(/Dated 2 code-owned key\(s\) that already matched the code: tech_stack, founderos_key_features/);
  });

  it("second run reports 0 filled and 0 retired, writes nothing, and does not bring a retired key back", async () => {
    await runSeed();
    const afterFirst = structuredClone(store.row);
    store.writes = 0;
    vi.mocked(console.log).mockClear();

    expect(await runSeed()).toBe(0);

    expect(store.writes).toBe(0);
    expect(store.row).toEqual(afterFirst);
    expect(logs()).toContain("Nothing to fill");
    expect(logs()).not.toMatch(/Filled|Removed|Rewrote|Dated/);
    for (const key of JUNE_KEYS) expect(store.row, key).not.toHaveProperty(key);
  });

  it("keeps a focus the founder wrote, and one he re-typed identical to the seed default", async () => {
    // The second is the case a value-only comparison gets wrong: /focus with the
    // exact June text stores a value EQUAL to the retired one. Its date says the
    // founder wrote it, so it stays.
    const june = String(PROD_ROW["current_focus"]);
    store.row = {
      ...structuredClone(PROD_ROW),
      current_focus: june,
      active_projects: ["FounderOS", "Naggar site"],
      [CONTEXT_META_KEY]: {
        current_focus: { at: "2026-09-30T04:00:00.000Z", source: "founder" },
        active_projects: { at: "2026-09-30T04:01:00.000Z", source: "founder" },
      },
    };

    await runSeed();

    expect(store.row?.["current_focus"]).toBe(june);
    expect(store.row?.["active_projects"]).toEqual(["FounderOS", "Naggar site"]);
    expect(meta()["current_focus"]).toEqual({ at: "2026-09-30T04:00:00.000Z", source: "founder" });
    expect(logs()).toContain("Removed 2 retired June seed value(s)"); // proof_gallery + portfolio_signal
    // The two he wrote are named as kept, so the deploy log accounts for all four.
    expect(logs()).toMatch(/Kept 2 stored value\(s\) under keys the seed used to write.*current_focus.*active_projects/);
  });

  it("names a June value that was NOT removed because it is one byte off, so the deploy log shows it", async () => {
    store.row = { ...structuredClone(PROD_ROW), portfolio_signal: `${String(PROD_ROW["portfolio_signal"])} ` };

    await runSeed();

    expect(store.row?.["portfolio_signal"]).toBe(`${String(PROD_ROW["portfolio_signal"])} `);
    expect(logs()).toContain("Removed 3 retired June seed value(s)");
    expect(logs()).toMatch(/Kept 1 stored value\(s\) under keys the seed used to write.*: portfolio_signal/);
  });

  it("removes the June values from a row whose meta is corrupt, repairs it, and names the problem", async () => {
    store.row = { ...structuredClone(PROD_ROW), [CONTEXT_META_KEY]: "garbage" };

    expect(await runSeed()).toBe(0);

    for (const key of JUNE_KEYS) expect(store.row, key).not.toHaveProperty(key);
    expect(typeof store.row?.[CONTEXT_META_KEY]).toBe("object");
    expect(logs()).toMatch(/context_meta/);
  });
});

describe("seed-founder-context — dates on a fresh row, and the seed never re-fills what it retires", () => {
  beforeEach(() => {
    store.row = undefined;
    store.writes = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DEPLOY_AT);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dates every key it fills: seed for the founder's facts, system for the code-owned three", async () => {
    await runSeed();

    const meta = store.row?.[CONTEXT_META_KEY] as Record<string, { at: string; source: string }>;
    const values = Object.keys(store.row ?? {}).filter((k) => k !== CONTEXT_META_KEY);
    expect(Object.keys(meta).sort()).toEqual([...values].sort());
    for (const key of values) {
      const expected = (SYSTEM_CONTEXT_KEYS as readonly string[]).includes(key) ? "system" : "seed";
      expect(meta[key], key).toEqual({ at: DEPLOY_AT.toISOString(), source: expected });
    }
  });

  it("seeds no key it also retires, and no value it would retire: that would flap on every deploy", async () => {
    await runSeed();

    for (const [key, value] of Object.entries(store.row ?? {})) {
      expect(Object.keys(RETIRED_SEED_VALUES), key).not.toContain(key);
      expect(isRetiredSeedValue(key, value), key).toBe(false);
    }
  });
});
