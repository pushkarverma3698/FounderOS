/**
 * context_meta: when each founder_context key was last written, and by whom.
 * ==========================================================================
 * The row has one `last_updated`, so a value the June seed wrote and one the
 * founder typed yesterday were indistinguishable. `context_meta` is the per-key
 * record: `{ [key]: { at: ISO, source: "founder" | "seed" | "system" } }`, kept in
 * the same JSONB so it needs no migration and can never disagree with the value
 * it describes (both land in one write).
 */

import { describe, it, expect } from "vitest";
import {
  CONTEXT_META_KEY,
  CONTEXT_SOURCES,
  pruneContextMeta,
  readContextMeta,
  stampContextMeta,
  type ContextSource,
} from "../../../src/db/context-meta.js";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const entry = (source: ContextSource, at = "2026-06-14T05:00:00.000Z") => ({ at, source });

describe("readContextMeta", () => {
  it("returns no entries and no problem for a row that has never had meta", () => {
    expect(readContextMeta({ current_focus: "x" })).toEqual({ entries: {}, problems: [] });
  });

  it("returns every well-formed entry as stored", () => {
    const meta = { current_focus: entry("founder"), tech_stack: entry("system") };
    expect(readContextMeta({ [CONTEXT_META_KEY]: meta })).toEqual({ entries: meta, problems: [] });
  });

  it.each([
    ["a string", "yesterday"],
    ["an array", [entry("founder")]],
    ["null", null],
    ["a number", 7],
    ["a boolean", true],
  ])("reports %s as one problem naming context_meta, with no entries and no throw", (_label, corrupt) => {
    const read = readContextMeta({ [CONTEXT_META_KEY]: corrupt });
    expect(read.entries).toEqual({});
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toContain(CONTEXT_META_KEY);
  });

  it("drops a broken entry, keeps its healthy neighbours, and names the broken keys in one problem", () => {
    const read = readContextMeta({
      [CONTEXT_META_KEY]: {
        current_focus: entry("founder"),
        notes: "yesterday",
        open_deals: { at: "not a date", source: "founder" },
        active_clients: { at: "2026-06-14T05:00:00.000Z", source: "somebody" },
        next_actions: { source: "founder" },
        active_projects: { at: 20260614, source: "founder" },
      },
    });
    expect(Object.keys(read.entries)).toEqual(["current_focus"]);
    expect(read.problems).toHaveLength(1);
    for (const key of ["notes", "open_deals", "active_clients", "next_actions", "active_projects"]) {
      expect(read.problems[0]).toContain(key);
    }
  });

  it("keeps a stored key named like an Object.prototype member as an own entry, and never reaches the prototype", () => {
    const stored = JSON.parse(
      '{"context_meta":{"__proto__":{"at":"2026-06-14T05:00:00.000Z","source":"founder"},"constructor":{"at":"2026-06-14T05:00:00.000Z","source":"seed"}}}',
    ) as Record<string, unknown>;
    const { entries, problems } = readContextMeta(stored);
    expect(problems).toEqual([]);
    expect(Object.keys(entries).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(entries)).toBe(Object.prototype);
  });

  it("knows exactly three sources", () => {
    expect([...CONTEXT_SOURCES]).toEqual(["founder", "seed", "system"]);
  });
});

describe("stampContextMeta", () => {
  it("stamps each key with the source and the injected time, keeping the other entries", () => {
    const before = { tech_stack: entry("system") };
    const after = stampContextMeta(before, ["current_focus", "active_projects"], "founder", NOW);
    expect(after).toEqual({
      tech_stack: entry("system"),
      current_focus: { at: NOW.toISOString(), source: "founder" },
      active_projects: { at: NOW.toISOString(), source: "founder" },
    });
  });

  it("re-stamps a key that already has an entry: confirming a value moves its date", () => {
    const after = stampContextMeta({ current_focus: entry("seed") }, ["current_focus"], "founder", NOW);
    expect(after["current_focus"]).toEqual({ at: NOW.toISOString(), source: "founder" });
  });

  it("does not mutate its input", () => {
    const before = { current_focus: entry("seed") };
    const copy = structuredClone(before);
    stampContextMeta(before, ["current_focus", "notes"], "founder", NOW);
    expect(before).toEqual(copy);
  });
});

describe("pruneContextMeta", () => {
  it("drops entries for keys that no longer exist, so a deleted value leaves no orphan date behind", () => {
    const pruned = pruneContextMeta({ current_focus: entry("seed"), notes: entry("founder") }, ["notes", "tech_stack"]);
    expect(pruned).toEqual({ notes: entry("founder") });
  });

  it("does not mutate its input", () => {
    const before = { current_focus: entry("seed") };
    pruneContextMeta(before, []);
    expect(before).toEqual({ current_focus: entry("seed") });
  });
});
