/**
 * founder_context helpers: one list of internal keys, fill-only seeding, and
 * bookkeeping writes that don't pose as founder updates.
 * ============================================================================
 * agents.founder_context is one JSONB row per tenant. The founder writes it
 * through update_context, the deploy seed fills defaults, and the budget alert
 * sweep keeps its dedupe state in the same row. Everything that renders the row
 * to the founder filters through INTERNAL_CONTEXT_KEYS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  INTERNAL_CONTEXT_KEYS,
  RETIRED_SEED_VALUES,
  SYSTEM_CONTEXT_KEYS,
  fillMissingContextKeys,
  founderFacingContext,
  hasFounderFacingContext,
  isRetiredSeedValue,
  mergeContextUpdates,
  reconcileSeededContext,
} from "../../../src/db/founder-context.js";
import { CONTEXT_META_KEY } from "../../../src/db/context-meta.js";
import { BUDGET_ALERTS_KEY } from "../../../src/infra/daily-budget.js";

const PROD_ROW = JSON.parse(
  readFileSync(new URL("../../fixtures/founder-context-prod-2026-09-29.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** 11:00 IST on 2026-09-30, the day the fix ships. */
const NOW = new Date("2026-09-30T05:30:00.000Z");
const NOW_ISO = NOW.toISOString();
const JUNE_AT = "2026-06-14T05:00:00.000Z";

const store = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));
const mockWarn = vi.hoisted(() => vi.fn());

// upsertFounderContext logs when a write rebuilds an unreadable context_meta; the
// test reads that line from here. Every other logger export stays real.
vi.mock("../../../src/infra/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/logger.js")>();
  return { ...actual, childLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (store.row ? [{ data: structuredClone(store.row) }] : []) }),
      }),
    }),
    insert: () => ({
      values: (v: { data: Record<string, unknown> }) => ({
        onConflictDoUpdate: async ({ set }: { set: { data: Record<string, unknown> } }) => {
          store.row = structuredClone(store.row ? set.data : v.data);
        },
      }),
    }),
  }),
}));

const { upsertFounderContext } = await import("../../../src/db/queries.js");

describe("INTERNAL_CONTEXT_KEYS", () => {
  it("lists the budget alert dedupe key the alert sweep writes", () => {
    expect(INTERNAL_CONTEXT_KEYS).toContain(BUDGET_ALERTS_KEY);
  });

  it("lists context_meta, so per-key dates never render as business context", () => {
    expect(INTERNAL_CONTEXT_KEYS).toContain(CONTEXT_META_KEY);
    expect(founderFacingContext({ notes: "x", [CONTEXT_META_KEY]: { notes: { at: NOW_ISO, source: "founder" } } })).toEqual({
      notes: "x",
    });
    expect(hasFounderFacingContext({ [CONTEXT_META_KEY]: {} })).toBe(false);
  });
});

describe("founderFacingContext", () => {
  it("drops internal keys and keeps everything else, last_updated included", () => {
    const ctx = {
      current_priorities: ["Ship"],
      last_updated: "2026-09-27T09:15:00.000Z",
      [BUDGET_ALERTS_KEY]: { date: "2026-09-28", levels: [80] },
    };
    expect(founderFacingContext(ctx)).toEqual({
      current_priorities: ["Ship"],
      last_updated: "2026-09-27T09:15:00.000Z",
    });
  });

  it("does not mutate its input", () => {
    const ctx = { [BUDGET_ALERTS_KEY]: { date: "2026-09-28", levels: [] } };
    founderFacingContext(ctx);
    expect(ctx).toHaveProperty(BUDGET_ALERTS_KEY);
  });
});

describe("hasFounderFacingContext", () => {
  it("is false for an empty row, a bookkeeping-only row, and a last_updated-only row", () => {
    expect(hasFounderFacingContext({})).toBe(false);
    expect(hasFounderFacingContext({ [BUDGET_ALERTS_KEY]: { date: "x", levels: [80] } })).toBe(false);
    expect(hasFounderFacingContext({ last_updated: "2026-09-27T09:15:00.000Z" })).toBe(false);
  });

  it("is true once any founder key is stored", () => {
    expect(hasFounderFacingContext({ notes: "Acme signed" })).toBe(true);
  });
});

describe("fillMissingContextKeys", () => {
  it("keeps every stored value and fills only absent keys", () => {
    const { data, filled } = fillMissingContextKeys(
      { current_priorities: ["Founder's own"], last_updated: "2026-09-27T09:15:00.000Z" },
      { current_priorities: ["Seed"], tech_stack: "Node 22" },
    );
    expect(data).toEqual({
      current_priorities: ["Founder's own"],
      last_updated: "2026-09-27T09:15:00.000Z",
      tech_stack: "Node 22",
    });
    expect(filled).toEqual(["tech_stack"]);
  });

  it("reports nothing filled when every default key is stored", () => {
    expect(fillMissingContextKeys({ a: 1 }, { a: 2 }).filled).toEqual([]);
  });
});

describe("upsertFounderContext — last_updated", () => {
  beforeEach(() => {
    store.row = { current_priorities: ["Ship"], last_updated: "2026-09-27T09:15:00.000Z" };
  });

  it("a bookkeeping-only write keeps the founder's last_updated", async () => {
    await upsertFounderContext("turicks", { [BUDGET_ALERTS_KEY]: { date: "2026-09-28", levels: [80] } }, "system");
    expect(store.row?.["last_updated"]).toBe("2026-09-27T09:15:00.000Z");
    expect(store.row?.[BUDGET_ALERTS_KEY]).toEqual({ date: "2026-09-28", levels: [80] });
  });

  it("a founder write still bumps last_updated", async () => {
    await upsertFounderContext("turicks", { current_priorities: ["Close Acme"] }, "founder");
    expect(store.row?.["last_updated"]).not.toBe("2026-09-27T09:15:00.000Z");
    expect(store.row?.["current_priorities"]).toEqual(["Close Acme"]);
  });
});

describe("upsertFounderContext — per-key dates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    store.row = { notes: "old", [CONTEXT_META_KEY]: { notes: { at: JUNE_AT, source: "seed" } } };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the key it wrote with the caller's source and the current time, and leaves the others' dates alone", async () => {
    await upsertFounderContext("turicks", { current_focus: "Ship the proof page" }, "founder");
    expect(store.row?.[CONTEXT_META_KEY]).toEqual({
      notes: { at: JUNE_AT, source: "seed" },
      current_focus: { at: NOW_ISO, source: "founder" },
    });
    expect(store.row?.["current_focus"]).toBe("Ship the proof page");
    expect(store.row?.["last_updated"]).toBe(NOW_ISO);
  });

  it("stamps nothing for a bookkeeping-only write: the budget state is never rendered, so it has no date to show", async () => {
    await upsertFounderContext("turicks", { [BUDGET_ALERTS_KEY]: { date: "2026-09-30", levels: [80] } }, "system");
    expect(store.row?.[CONTEXT_META_KEY]).toEqual({ notes: { at: JUNE_AT, source: "seed" } });
  });

  it("over an unreadable context_meta: rebuilds it from the keys it dated, and logs that it did", async () => {
    mockWarn.mockClear();
    store.row = { notes: "old", [CONTEXT_META_KEY]: "garbage" };

    await upsertFounderContext("turicks", { current_focus: "F" }, "founder");

    expect(store.row?.[CONTEXT_META_KEY]).toEqual({ current_focus: { at: NOW_ISO, source: "founder" } });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls[0])).toContain(CONTEXT_META_KEY);
  });

  it("stays quiet when the meta is healthy, and for a bookkeeping write that leaves an unreadable meta alone", async () => {
    mockWarn.mockClear();
    await upsertFounderContext("turicks", { current_focus: "F" }, "founder");
    store.row = { notes: "old", [CONTEXT_META_KEY]: "garbage" };
    await upsertFounderContext("turicks", { [BUDGET_ALERTS_KEY]: { date: "2026-09-30", levels: [80] } }, "system");
    expect(mockWarn).not.toHaveBeenCalled();
    expect(store.row?.[CONTEXT_META_KEY]).toBe("garbage"); // not rebuilt, so nothing to announce
  });
});

describe("mergeContextUpdates", () => {
  const current = {
    notes: "old",
    tech_stack: "T",
    last_updated: "2026-09-27T09:15:00.000Z",
    [CONTEXT_META_KEY]: {
      notes: { at: JUNE_AT, source: "seed" },
      tech_stack: { at: JUNE_AT, source: "system" },
    },
  };

  it("stamps every founder key it writes with the source and the injected time, and bumps last_updated", () => {
    const merged = mergeContextUpdates(current, { current_focus: "F", active_projects: ["A", "B"] }, NOW, "founder");
    expect(merged["current_focus"]).toBe("F");
    expect(merged["last_updated"]).toBe(NOW_ISO);
    expect(merged[CONTEXT_META_KEY]).toEqual({
      notes: { at: JUNE_AT, source: "seed" },
      tech_stack: { at: JUNE_AT, source: "system" },
      current_focus: { at: NOW_ISO, source: "founder" },
      active_projects: { at: NOW_ISO, source: "founder" },
    });
  });

  it("records the source it is given, so a system write is not passed off as the founder's", () => {
    const merged = mergeContextUpdates({}, { notes: "n" }, NOW, "system");
    expect(merged[CONTEXT_META_KEY]).toEqual({ notes: { at: NOW_ISO, source: "system" } });
  });

  it("re-stamps a key written again with the same value: confirming a value moves its date", () => {
    const merged = mergeContextUpdates(current, { notes: "old" }, NOW, "founder");
    expect((merged[CONTEXT_META_KEY] as Record<string, unknown>)["notes"]).toEqual({ at: NOW_ISO, source: "founder" });
  });

  it("stamps nothing and keeps last_updated for a bookkeeping-only write", () => {
    const merged = mergeContextUpdates(current, { [BUDGET_ALERTS_KEY]: { date: "2026-09-30", levels: [80] } }, NOW, "system");
    expect(merged["last_updated"]).toBe("2026-09-27T09:15:00.000Z");
    expect(merged[CONTEXT_META_KEY]).toEqual(current[CONTEXT_META_KEY]);
  });

  it("ignores a context_meta key in the updates: a caller cannot write dates by hand", () => {
    const forged = { current_focus: { at: "2026-09-30T00:00:00.000Z", source: "founder" } };
    const merged = mergeContextUpdates(current, { notes: "n", [CONTEXT_META_KEY]: forged }, NOW, "seed");
    expect(merged[CONTEXT_META_KEY]).toEqual({
      notes: { at: NOW_ISO, source: "seed" },
      tech_stack: { at: JUNE_AT, source: "system" },
    });
    expect(mergeContextUpdates(current, { [CONTEXT_META_KEY]: forged }, NOW, "founder")[CONTEXT_META_KEY]).toEqual(
      current[CONTEXT_META_KEY],
    );
  });

  it("repairs a corrupt context_meta on write instead of throwing", () => {
    for (const corrupt of ["yesterday", [1, 2], null, 7]) {
      const merged = mergeContextUpdates({ notes: "old", [CONTEXT_META_KEY]: corrupt }, { current_focus: "F" }, NOW, "founder");
      expect(merged[CONTEXT_META_KEY]).toEqual({ current_focus: { at: NOW_ISO, source: "founder" } });
    }
  });

  it("drops the date of a key that has no value, so no orphan is left behind", () => {
    const orphaned = { ...current, [CONTEXT_META_KEY]: { ...current[CONTEXT_META_KEY], gone: { at: JUNE_AT, source: "seed" } } };
    const merged = mergeContextUpdates(orphaned, { current_focus: "F" }, NOW, "founder");
    expect(Object.keys(merged[CONTEXT_META_KEY] as object)).not.toContain("gone");
  });

  it("does not mutate the stored row or the updates", () => {
    const before = structuredClone(current);
    const updates = { current_focus: "F" };
    mergeContextUpdates(current, updates, NOW, "founder");
    expect(current).toEqual(before);
    expect(updates).toEqual({ current_focus: "F" });
  });
});

describe("isRetiredSeedValue", () => {
  const RETIRED = {
    // An object-valued default, as a structured active_projects would be.
    active_projects: [
      [
        { name: "FounderOS", stage: { status: "live", host: "hetzner" } },
        { name: "Naggar", tags: ["homestay", "himachal"] },
      ],
    ],
  };
  const stored = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

  it("matches a value read back from JSONB, whatever order its keys came back in", () => {
    const readBack = stored([
      { stage: { host: "hetzner", status: "live" }, name: "FounderOS" },
      { tags: ["homestay", "himachal"], name: "Naggar" },
    ]);
    expect(isRetiredSeedValue("active_projects", readBack, RETIRED)).toBe(true);
  });

  it("does not match a copy that differs anywhere, however deep", () => {
    const base = RETIRED.active_projects[0] as Array<Record<string, unknown>>;
    const variants: unknown[] = [
      [...base.slice(0, 1)], // an element fewer
      [...base, { name: "Extra" }], // an element more
      [base[1], base[0]], // same elements, other order
      stored([{ ...base[0], stage: { status: "live", host: "vps" } }, base[1]]), // nested value changed
      stored([{ ...base[0], extra: 1 }, base[1]]), // extra key
      stored([base[0], { name: "Naggar", tags: ["homestay"] }]), // shorter nested array
      "FounderOS; Naggar", // wrong type
    ];
    for (const variant of variants) expect(isRetiredSeedValue("active_projects", variant, RETIRED), JSON.stringify(variant)).toBe(false);
  });

  it("matches ANY of the values listed for a key", () => {
    const retired = { current_focus: ["first text", "second text"] };
    expect(isRetiredSeedValue("current_focus", "first text", retired)).toBe(true);
    expect(isRetiredSeedValue("current_focus", "second text", retired)).toBe(true);
    expect(isRetiredSeedValue("current_focus", "third text", retired)).toBe(false);
  });

  it("is false for a key that is not listed, including names Object.prototype has", () => {
    for (const key of ["location", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isRetiredSeedValue(key, "x")).toBe(false);
    }
  });
});

describe("RETIRED_SEED_VALUES — what prod still holds", () => {
  const JUNE_KEYS = ["current_focus", "active_projects", "proof_gallery", "portfolio_signal"];

  it("retires exactly the four June values the 2026-09-29 prod row still holds, and nothing else in it", () => {
    const retired = Object.keys(PROD_ROW).filter((key) => isRetiredSeedValue(key, PROD_ROW[key]));
    expect(retired.sort()).toEqual([...JUNE_KEYS].sort());
  });

  it("retires the YOUR_VPS_IP placeholder the proof_gallery seed wrote", () => {
    expect(String(PROD_ROW["proof_gallery"])).toContain("YOUR_VPS_IP");
    expect(isRetiredSeedValue("proof_gallery", PROD_ROW["proof_gallery"])).toBe(true);
  });

  it("lists both texts the seed used for active_projects: the June v2 line prod holds, and today's v3 line", () => {
    // The plan said to retire "the exact current seed values". The seed's first
    // project line was rewritten to v3 in #767, so the current text is NOT what
    // prod holds: prod still has the v2 array, and retiring only today's text
    // would have left it in place.
    const texts = (RETIRED_SEED_VALUES["active_projects"] ?? []).map((list) => String((list as string[])[0]));
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("FounderOS v2"))).toBe(true);
    expect(texts.some((t) => t.includes("(v3)"))).toBe(true);
    expect(isRetiredSeedValue("active_projects", PROD_ROW["active_projects"])).toBe(true);
  });

  it("keeps retiring the four values #767 listed", () => {
    for (const key of ["current_priorities", "recent_wins", "next_actions", "open_decisions"]) {
      const [first] = RETIRED_SEED_VALUES[key] ?? [];
      expect(first, key).toBeDefined();
      expect(isRetiredSeedValue(key, structuredClone(first))).toBe(true);
    }
  });

  it("does not retire a value the founder wrote under the same key", () => {
    for (const key of JUNE_KEYS) expect(isRetiredSeedValue(key, key === "active_projects" ? ["FounderOS v3"] : "Close Acme")).toBe(false);
  });
});

describe("reconcileSeededContext — dates", () => {
  const defaults = { location: "Amsterdam", turicks_pricing: "$8K", tech_stack: "v3 kernel", founderos_departments: "8 workers" };

  it("stamps a filled key as seed and a filled system key as system, both at the deploy time", () => {
    const { data, filled } = reconcileSeededContext({}, defaults, NOW);
    expect(filled.sort()).toEqual(["founderos_departments", "location", "tech_stack", "turicks_pricing"]);
    expect(data[CONTEXT_META_KEY]).toEqual({
      location: { at: NOW_ISO, source: "seed" },
      turicks_pricing: { at: NOW_ISO, source: "seed" },
      tech_stack: { at: NOW_ISO, source: "system" },
      founderos_departments: { at: NOW_ISO, source: "system" },
    });
  });

  it("stamps a refreshed system key as system at the deploy time", () => {
    const current = { ...defaults, tech_stack: "v2 supervisor", [CONTEXT_META_KEY]: { tech_stack: { at: JUNE_AT, source: "system" } } };
    const { data, refreshed } = reconcileSeededContext(current, defaults, NOW);
    expect(refreshed).toEqual(["tech_stack"]);
    expect(data["tech_stack"]).toBe("v3 kernel");
    expect((data[CONTEXT_META_KEY] as Record<string, unknown>)["tech_stack"]).toEqual({ at: NOW_ISO, source: "system" });
  });

  it("gives a system key that already matches the code, and has no date, its first date", () => {
    // Every system key in prod today: current (rewritten by #767's deploy) but
    // undated. Without this they would read "date unknown, ask before relying on
    // it" about FounderOS's own description, on every read, indefinitely.
    const { data, dated, refreshed, filled } = reconcileSeededContext({ ...defaults }, defaults, NOW);
    expect([filled, refreshed]).toEqual([[], []]);
    expect(dated.sort()).toEqual(["founderos_departments", "tech_stack"]);
    expect(data[CONTEXT_META_KEY]).toEqual({
      tech_stack: { at: NOW_ISO, source: "system" },
      founderos_departments: { at: NOW_ISO, source: "system" },
    });
  });

  it("leaves an unchanged non-system key undated: no meta means date unknown, and that must stay loud", () => {
    const { data } = reconcileSeededContext({ ...defaults }, defaults, NOW);
    expect(Object.keys(data[CONTEXT_META_KEY] as object)).not.toContain("location");
    expect(Object.keys(data[CONTEXT_META_KEY] as object)).not.toContain("turicks_pricing");
  });

  it("is idempotent: a second run reports 0 filled, 0 refreshed, 0 retired, 0 dated, and returns the same row", () => {
    const first = reconcileSeededContext(PROD_ROW, defaults, NOW);
    const stored = JSON.parse(JSON.stringify(first.data)) as Record<string, unknown>;
    const second = reconcileSeededContext(stored, defaults, new Date(NOW.getTime() + 86_400_000));
    expect([second.filled, second.refreshed, second.retired, second.dated]).toEqual([[], [], [], []]);
    expect(second.data).toEqual(stored);
  });

  it("does not touch last_updated, the budget state, or any value it does not own", () => {
    const { data } = reconcileSeededContext(PROD_ROW, defaults, NOW);
    expect(data["last_updated"]).toBe(PROD_ROW["last_updated"]);
    expect(data[BUDGET_ALERTS_KEY]).toEqual(PROD_ROW[BUDGET_ALERTS_KEY]);
    expect(data["founder"]).toBe(PROD_ROW["founder"]);
  });

  it("repairs a corrupt context_meta and reports the problem, so a deploy log names it", () => {
    const { data, metaProblems } = reconcileSeededContext({ [CONTEXT_META_KEY]: "garbage" }, defaults, NOW);
    expect(metaProblems).toHaveLength(1);
    expect(metaProblems[0]).toContain(CONTEXT_META_KEY);
    expect(typeof data[CONTEXT_META_KEY]).toBe("object");
    expect(Array.isArray(data[CONTEXT_META_KEY])).toBe(false);
  });

  it("rewrites an unreadable context_meta even when nothing else needs doing, and the run after that is a no-op", () => {
    const first = reconcileSeededContext({ ...defaults, [CONTEXT_META_KEY]: "garbage" }, {}, NOW);
    expect(first.metaProblems).toHaveLength(1);
    expect(first.data[CONTEXT_META_KEY]).toEqual({});

    const second = reconcileSeededContext(JSON.parse(JSON.stringify(first.data)) as Record<string, unknown>, {}, NOW);
    expect([second.filled, second.refreshed, second.retired, second.dated, second.metaProblems]).toEqual([[], [], [], [], []]);
  });

  it("does not mutate the stored row or the defaults", () => {
    const current = structuredClone(PROD_ROW);
    const seed = structuredClone(defaults);
    reconcileSeededContext(current, seed, NOW);
    expect(current).toEqual(PROD_ROW);
    expect(seed).toEqual(defaults);
  });
});

describe("reconcileSeededContext — retiring seed values", () => {
  const RETIRED = { current_focus: ["June plan"], active_projects: [["Old A", "Old B"], ["New A", "Old B"]] };
  const at = { at: JUNE_AT };

  it("removes a stored value still equal to a retired one, and its date with it: no orphan meta", () => {
    const current = {
      current_focus: "June plan",
      notes: "keep",
      [CONTEXT_META_KEY]: { current_focus: { ...at, source: "seed" }, notes: { ...at, source: "founder" } },
    };
    const { data, retired } = reconcileSeededContext(current, {}, NOW, RETIRED);
    expect(retired).toEqual(["current_focus"]);
    expect(data).not.toHaveProperty("current_focus");
    expect(data[CONTEXT_META_KEY]).toEqual({ notes: { ...at, source: "founder" } });
  });

  it("removes a retired value that never had a date", () => {
    const { data, retired } = reconcileSeededContext({ current_focus: "June plan" }, {}, NOW, RETIRED);
    expect(retired).toEqual(["current_focus"]);
    expect(data).not.toHaveProperty("current_focus");
  });

  it("keeps a value the founder edited, and its date", () => {
    const current = {
      current_focus: "Close Acme this week",
      [CONTEXT_META_KEY]: { current_focus: { at: NOW_ISO, source: "founder" } },
    };
    const { data, retired } = reconcileSeededContext(current, {}, NOW, RETIRED);
    expect(retired).toEqual([]);
    expect(data["current_focus"]).toBe("Close Acme this week");
    expect(data[CONTEXT_META_KEY]).toEqual(current[CONTEXT_META_KEY]);
  });

  it("never retires a value the founder confirmed, even when it is identical to the retired seed value", () => {
    const current = {
      current_focus: "June plan",
      [CONTEXT_META_KEY]: { current_focus: { at: NOW_ISO, source: "founder" } },
    };
    const { data, retired } = reconcileSeededContext(current, {}, NOW, RETIRED);
    expect(retired).toEqual([]);
    expect(data["current_focus"]).toBe("June plan");
    expect((data[CONTEXT_META_KEY] as Record<string, unknown>)["current_focus"]).toEqual({ at: NOW_ISO, source: "founder" });
  });

  it("still retires an identical value whose date says the seed wrote it", () => {
    const current = { current_focus: "June plan", [CONTEXT_META_KEY]: { current_focus: { ...at, source: "seed" } } };
    expect(reconcileSeededContext(current, {}, NOW, RETIRED).retired).toEqual(["current_focus"]);
  });

  it("names the keys the seed used to write that it kept, so a value one byte off is visible in the deploy log", () => {
    const current = {
      current_focus: "June plan ", // one trailing space: NOT the retired text
      active_projects: ["Old A", "Old B"], // equal: retired, so not "survived"
      notes: "unrelated",
      [CONTEXT_META_KEY]: {},
    };
    const { retired, survived } = reconcileSeededContext(current, {}, NOW, RETIRED);
    expect(retired).toEqual(["active_projects"]);
    expect(survived).toEqual(["current_focus"]);
  });

  it("counts a founder-confirmed value as kept, not retired; and a key that is not stored as neither", () => {
    const current = { current_focus: "June plan", [CONTEXT_META_KEY]: { current_focus: { at: NOW_ISO, source: "founder" } } };
    const { retired, survived } = reconcileSeededContext(current, {}, NOW, RETIRED);
    expect([retired, survived]).toEqual([[], ["current_focus"]]);
    expect(reconcileSeededContext({}, {}, NOW, RETIRED).survived).toEqual([]);
  });

  it("retires whichever listed text is stored, and compares arrays element by element", () => {
    const v2 = reconcileSeededContext({ active_projects: ["Old A", "Old B"] }, {}, NOW, RETIRED);
    const v3 = reconcileSeededContext({ active_projects: ["New A", "Old B"] }, {}, NOW, RETIRED);
    const edited = reconcileSeededContext({ active_projects: ["New A", "Old B", "Mine"] }, {}, NOW, RETIRED);
    expect([v2.retired, v3.retired, edited.retired]).toEqual([["active_projects"], ["active_projects"], []]);
  });

  it("retires the prod row's four June values, keeps the rest, and dates the code-owned keys", () => {
    const seedDefaults = {
      founder: PROD_ROW["founder"],
      tech_stack: PROD_ROW["tech_stack"],
      founderos_departments: PROD_ROW["founderos_departments"],
      founderos_key_features: PROD_ROW["founderos_key_features"],
    };
    const { data, retired, filled, refreshed, dated } = reconcileSeededContext(PROD_ROW, seedDefaults, NOW);
    expect(retired.sort()).toEqual(["active_projects", "current_focus", "portfolio_signal", "proof_gallery"]);
    expect([filled, refreshed]).toEqual([[], []]);
    expect(dated.sort()).toEqual([...SYSTEM_CONTEXT_KEYS].sort());
    for (const key of retired) expect(data).not.toHaveProperty(key);
    expect(Object.keys(data)).toHaveLength(Object.keys(PROD_ROW).length - 4 + 1); // minus 4 retired, plus context_meta
    expect(data[CONTEXT_META_KEY]).toEqual({
      tech_stack: { at: NOW_ISO, source: "system" },
      founderos_departments: { at: NOW_ISO, source: "system" },
      founderos_key_features: { at: NOW_ISO, source: "system" },
    });
  });
});
