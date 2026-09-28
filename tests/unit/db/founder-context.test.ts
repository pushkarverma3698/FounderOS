/**
 * founder_context helpers: one list of internal keys, fill-only seeding, and
 * bookkeeping writes that don't pose as founder updates.
 * ============================================================================
 * agents.founder_context is one JSONB row per tenant. The founder writes it
 * through update_context, the deploy seed fills defaults, and the budget alert
 * sweep keeps its dedupe state in the same row. Everything that renders the row
 * to the founder filters through INTERNAL_CONTEXT_KEYS.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  INTERNAL_CONTEXT_KEYS,
  fillMissingContextKeys,
  founderFacingContext,
  hasFounderFacingContext,
} from "../../../src/db/founder-context.js";
import { BUDGET_ALERTS_KEY } from "../../../src/infra/daily-budget.js";

const store = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));

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
    await upsertFounderContext("turicks", { [BUDGET_ALERTS_KEY]: { date: "2026-09-28", levels: [80] } });
    expect(store.row?.["last_updated"]).toBe("2026-09-27T09:15:00.000Z");
    expect(store.row?.[BUDGET_ALERTS_KEY]).toEqual({ date: "2026-09-28", levels: [80] });
  });

  it("a founder write still bumps last_updated", async () => {
    await upsertFounderContext("turicks", { current_priorities: ["Close Acme"] });
    expect(store.row?.["last_updated"]).not.toBe("2026-09-27T09:15:00.000Z");
    expect(store.row?.["current_priorities"]).toEqual(["Close Acme"]);
  });
});
