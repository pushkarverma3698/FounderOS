/**
 * The founder-context renderer: every value is printed with the date it was
 * last confirmed, and one that may be stale says so.
 * ============================================================================
 * 2026-09-29 prod audit: agents.founder_context is ONE JSONB blob with one
 * row-level `last_updated` (2026-09-28T13:19:27Z), but the June seed wrote most
 * of its values. read_context printed that single date under the whole list, so
 * June's "Phase D-Bis: 3 proof showcases…" read as a value confirmed a day ago,
 * and the bot quoted it as the founder's current focus.
 *
 * The renderer is pure: `now` and the time zone are arguments, so every case
 * below is a fixed input and a fixed string. Only the tool wrapper reads the
 * real clock.
 *
 * The fixture is the prod row as it stood on 2026-09-29, rebuilt from the seed's
 * git history (values the seed-over-stored deploys wrote before 2026-09-28) plus
 * the row facts the plan measured. The plan counted 22 keys; the 22nd is not
 * named anywhere, so the fixture holds the 21 that can be reconstructed.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CONTEXT_META_KEY, CONTEXT_STALE_MARKER } from "../../../src/db/context-meta.js";
import { INTERNAL_CONTEXT_KEYS } from "../../../src/db/founder-context.js";
import { appTimeZone } from "../../../src/core/time.js";
import {
  CONTEXT_STALE_ADVICE,
  CONTEXT_STALE_DAYS,
  NO_CONTEXT_MESSAGE,
  contextLineRenderer,
  renderFounderContext,
} from "../../../src/tools/context-render.js";

const PROD_ROW = JSON.parse(
  readFileSync(new URL("../../fixtures/founder-context-prod-2026-09-29.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const IST = "Asia/Kolkata";
/** 14:30 IST on 2026-09-29. */
const NOW = new Date("2026-09-29T09:00:00.000Z");
const DAY_MS = 86_400_000;

type Meta = Record<string, { at: string; source: string }>;
const withMeta = (ctx: Record<string, unknown>, meta: unknown): Record<string, unknown> => ({
  ...ctx,
  [CONTEXT_META_KEY]: meta,
});
const focusRow = (meta: unknown): Record<string, unknown> =>
  withMeta({ current_focus: "Ship the proof page" }, meta);
const render = (ctx: Record<string, unknown>, now = NOW, timeZone = IST, warn?: (p: string) => void): string =>
  renderFounderContext(ctx, now, { timeZone, ...(warn ? { warn } : {}) });
const focusLine = (text: string): string => text.split("\n").find((l) => l.startsWith("• current focus")) ?? "";
const bulletLines = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("• "));
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * DAY_MS).toISOString();

describe("renderFounderContext — the 2026-09-29 prod row", () => {
  it("does not present June's current_focus as current: it says the date is unknown", () => {
    const line = focusLine(render(PROD_ROW));
    expect(line).toContain("• current focus: Phase D-Bis: 3 proof showcases");
    expect(line).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
    expect(line).toContain(CONTEXT_STALE_ADVICE);
  });

  it("drops the row-level 'Last updated' footer that made June data look one day old", () => {
    const text = render(PROD_ROW);
    expect(text).not.toMatch(/last updated/i);
    expect(text).not.toContain("2026-09-28");
  });

  it("flags every value in the row, because no key has a date yet", () => {
    const lines = bulletLines(render(PROD_ROW));
    const expected = Object.keys(PROD_ROW).filter((k) => k !== "last_updated" && !INTERNAL_CONTEXT_KEYS.includes(k));
    expect(lines).toHaveLength(expected.length);
    for (const line of lines) expect(line, line).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
  });

  it("never prints bookkeeping: the budget-alert state, the meta itself, last_updated", () => {
    const text = render(withMeta(PROD_ROW, { current_focus: { at: NOW.toISOString(), source: "founder" } }));
    expect(text).not.toContain("budget alerts sent");
    expect(text).not.toContain("context meta");
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("last updated");
  });

  it("gives a value the founder confirmed today its date and no warning, while the rest stay flagged", () => {
    const text = render(withMeta(PROD_ROW, { current_focus: { at: NOW.toISOString(), source: "founder" } }));
    expect(focusLine(text)).toMatch(/\(confirmed 2026-09-29\)$/);
    expect(focusLine(text)).not.toContain(CONTEXT_STALE_MARKER);
    const flagged = bulletLines(text).filter((l) => l.includes(CONTEXT_STALE_MARKER));
    expect(flagged).toHaveLength(bulletLines(text).length - 1);
  });
});

describe("renderFounderContext — how old is too old", () => {
  it("flags a value last confirmed in June with that date and the advice to ask", () => {
    const line = focusLine(render(focusRow({ current_focus: { at: "2026-06-12T08:00:00.000Z", source: "founder" } })));
    expect(line).toBe(
      `• current focus: Ship the proof page ${CONTEXT_STALE_MARKER} last confirmed 2026-06-12, ${CONTEXT_STALE_ADVICE}`,
    );
  });

  it(`leaves a value exactly ${CONTEXT_STALE_DAYS} days old unflagged and flags one day older`, () => {
    const atLimit = focusLine(render(focusRow({ current_focus: { at: daysAgo(CONTEXT_STALE_DAYS), source: "founder" } })));
    expect(atLimit).toMatch(/\(confirmed 2026-08-30\)$/);
    expect(atLimit).not.toContain(CONTEXT_STALE_MARKER);

    const past = focusLine(render(focusRow({ current_focus: { at: daysAgo(CONTEXT_STALE_DAYS + 1), source: "founder" } })));
    expect(past).toContain(`${CONTEXT_STALE_MARKER} last confirmed 2026-08-29`);
  });

  it("counts the days between the dates the founder reads, not elapsed hours", () => {
    // Confirmed 23:50 IST on 30 Aug; now is 00:10 IST on 30 Sep. Only 29 days and
    // 20 minutes have elapsed, but the line says 2026-08-30 and today is 30 Sep:
    // 31 days on the calendar he counts on, which is past the limit.
    const line = focusLine(
      render(
        focusRow({ current_focus: { at: "2026-08-30T18:20:00.000Z", source: "founder" } }),
        new Date("2026-09-29T18:40:00.000Z"),
      ),
    );
    expect(line).toContain(`${CONTEXT_STALE_MARKER} last confirmed 2026-08-30`);
  });
});

describe("renderFounderContext — dates are the founder's, not UTC's", () => {
  it("reads a value confirmed at 00:30 IST on the 30th as 2026-09-30", () => {
    const now = new Date("2026-09-30T05:00:00.000Z");
    const line = focusLine(render(focusRow({ current_focus: { at: "2026-09-29T19:00:00.000Z", source: "founder" } }), now));
    expect(line).toMatch(/\(confirmed 2026-09-30\)$/);
    expect(line).not.toContain("2026-09-29");
  });

  it("reads 23:59:59 IST on the 29th, one second earlier, as 2026-09-29", () => {
    const now = new Date("2026-09-30T05:00:00.000Z");
    const line = focusLine(render(focusRow({ current_focus: { at: "2026-09-29T18:29:59.000Z", source: "founder" } }), now));
    expect(line).toMatch(/\(confirmed 2026-09-29\)$/);
  });

  it("follows the zone it is given: the same instant is still the 29th in Los Angeles", () => {
    const at = "2026-09-30T06:30:00.000Z"; // 23:30 PDT on the 29th, 12:00 IST on the 30th
    const now = new Date("2026-09-30T20:00:00.000Z");
    const la = focusLine(render(focusRow({ current_focus: { at, source: "founder" } }), now, "America/Los_Angeles"));
    const ist = focusLine(render(focusRow({ current_focus: { at, source: "founder" } }), now, IST));
    expect(la).toMatch(/\(confirmed 2026-09-29\)$/);
    expect(ist).toMatch(/\(confirmed 2026-09-30\)$/);
  });

  it("uses the app time zone when none is given", () => {
    const ctx = focusRow({ current_focus: { at: "2026-09-29T19:00:00.000Z", source: "founder" } });
    const now = new Date("2026-09-30T05:00:00.000Z");
    expect(renderFounderContext(ctx, now)).toBe(renderFounderContext(ctx, now, { timeZone: appTimeZone() }));
  });
});

describe("renderFounderContext — clock skew and odd dates", () => {
  it("treats a date in the future as today: never negative days, never a warning", () => {
    for (const at of [new Date(NOW.getTime() + 3 * DAY_MS).toISOString(), "2099-01-01T00:00:00.000Z"]) {
      const line = focusLine(render(focusRow({ current_focus: { at, source: "founder" } })));
      expect(line).toMatch(/\(confirmed 2026-09-29\)$/);
      expect(line).not.toContain(CONTEXT_STALE_MARKER);
    }
  });

  it("reads the 1970-01-01 sentinel as an unknown date, the same as no meta", () => {
    const line = focusLine(render(focusRow({ current_focus: { at: "1970-01-01T00:00:00.000Z", source: "seed" } })));
    expect(line).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
  });
});

describe("renderFounderContext — who wrote the value", () => {
  it("says a fresh seed default was seeded, not confirmed", () => {
    const line = focusLine(render(focusRow({ current_focus: { at: daysAgo(1), source: "seed" } })));
    expect(line).toMatch(/\(seeded 2026-09-28\)$/);
  });

  it("flags an old seed default as last seeded, with the advice to ask", () => {
    const line = focusLine(render(focusRow({ current_focus: { at: "2026-06-14T05:00:00.000Z", source: "seed" } })));
    expect(line).toContain(`${CONTEXT_STALE_MARKER} last seeded 2026-06-14, ${CONTEXT_STALE_ADVICE}`);
  });

  it("never ages out a value the deploy code owns: it is rewritten on every deploy that changes it", () => {
    const line = focusLine(render(focusRow({ current_focus: { at: daysAgo(400), source: "system" } })));
    expect(line).toMatch(/\(confirmed 2025-08-25\)$/);
    expect(line).not.toContain(CONTEXT_STALE_MARKER);
  });
});

describe("renderFounderContext — a corrupt context_meta", () => {
  it.each([
    ["a string", "yesterday"],
    ["an array", [{ at: NOW.toISOString(), source: "founder" }]],
    ["null", null],
    ["a number", 42],
  ])("when it is %s: warns once, renders every key as date unknown, does not throw", (_label, corrupt) => {
    const warn = vi.fn();
    let text = "";
    expect(() => (text = render(withMeta({ current_focus: "A", active_clients: ["B"], notes: "C" }, corrupt), NOW, IST, warn))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(CONTEXT_META_KEY);
    expect(bulletLines(text)).toHaveLength(3);
    for (const line of bulletLines(text)) expect(line, line).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
  });

  it("when only some entries are broken: warns once naming them, and still honours the good ones", () => {
    const warn = vi.fn();
    const text = render(
      withMeta({ current_focus: "A", active_clients: ["B"], notes: "C", open_deals: ["D"] }, {
        current_focus: { at: NOW.toISOString(), source: "founder" },
        active_clients: "yesterday",
        notes: { at: "not a date", source: "founder" },
        open_deals: { at: NOW.toISOString(), source: "somebody" },
      }),
      NOW,
      IST,
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const problem = String(warn.mock.calls[0]?.[0]);
    for (const key of ["active_clients", "notes", "open_deals"]) expect(problem).toContain(key);
    expect(focusLine(text)).toMatch(/\(confirmed 2026-09-29\)$/);
    expect(bulletLines(text).filter((l) => l.includes("date unknown"))).toHaveLength(3);
  });

  it("does not warn when the meta is healthy or absent", () => {
    const warn = vi.fn();
    render(PROD_ROW, NOW, IST, warn);
    render(focusRow({ current_focus: { at: NOW.toISOString(), source: "founder" } }), NOW, IST, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("renderFounderContext — values", () => {
  it("joins arrays, skips empty ones, and prints (none) for a null", () => {
    const text = render({ active_clients: ["Acme", "Beta"], open_deals: [], notes: null });
    expect(text).toContain("• active clients: Acme, Beta");
    expect(text).not.toContain("open deals");
    expect(text).toContain("• notes: (none)");
  });

  it("prints an array of objects as JSON, never [object Object]", () => {
    const text = render({ active_projects: [{ name: "FounderOS", stage: "live" }, { name: "Naggar" }] });
    expect(text).toContain('{"name":"FounderOS","stage":"live"}, {"name":"Naggar"}');
    expect(text).not.toContain("[object Object]");
  });

  it("asks the founder for context when the row holds none, bookkeeping included", () => {
    expect(render({})).toBe(NO_CONTEXT_MESSAGE);
    expect(render({ budget_alerts_sent: { date: "2026-09-28", levels: [80] }, last_updated: "2026-09-28T07:00:00.000Z" })).toBe(
      NO_CONTEXT_MESSAGE,
    );
    expect(render({ [CONTEXT_META_KEY]: { current_focus: { at: NOW.toISOString(), source: "founder" } } })).toBe(NO_CONTEXT_MESSAGE);
  });

  it("does not mutate its input and gives the same text for the same input", () => {
    const ctx = withMeta(structuredClone(PROD_ROW), { current_focus: { at: daysAgo(2), source: "founder" } });
    const before = structuredClone(ctx);
    const first = render(ctx);
    expect(render(ctx)).toBe(first);
    expect(ctx).toEqual(before);
  });
});

describe("contextLineRenderer — the same line for search_memory", () => {
  it("dates each line from the row's own meta and warns once for a corrupt one", () => {
    const warn = vi.fn();
    const line = contextLineRenderer(
      withMeta({ current_focus: "Ship" }, { current_focus: { at: NOW.toISOString(), source: "founder" } } as Meta),
      NOW,
      { timeZone: IST, warn },
    );
    expect(line("current_focus", "Ship")).toBe("• current focus: Ship (confirmed 2026-09-29)");
    expect(line("active_clients", ["Acme"])).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
    expect(warn).not.toHaveBeenCalled();

    const broken = contextLineRenderer(withMeta({}, "nope"), NOW, { timeZone: IST, warn });
    broken("a", "x");
    broken("b", "y");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
