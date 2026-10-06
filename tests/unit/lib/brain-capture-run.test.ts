import { describe, it, expect, vi } from "vitest";
import { planRun, parseState, EMPTY_STATE, type Candidate } from "../../../src/lib/brain-capture-run.js";
import type { DigestRecord } from "../../../src/lib/brain-digest.js";

const rec = (id: string, content = `content ${id}`): DigestRecord => ({
  source: "mac-claude", source_id: id, memory_type: "session", project: null, content,
  metadata: { origin: "mac-claude", occurred_at: "2026-10-06T00:00:00.000Z", visibility: "founder" },
});
const cand = (id: string, mtimeMs: number, content?: string): Candidate & { build: ReturnType<typeof vi.fn> } => ({
  key: id, label: `/path/${id}`, mtimeMs, build: vi.fn(() => rec(id, content)),
});

describe("planRun", () => {
  it("emits new records newest first", () => {
    const plan = planRun([cand("old", 1), cand("new", 9)], EMPTY_STATE, 10);
    expect(plan.records.map((r) => r.source_id)).toEqual(["new", "old"]);
  });

  it("is idempotent: a second run on its own state emits nothing and does not rebuild", () => {
    const first = planRun([cand("a", 1), cand("b", 2)], EMPTY_STATE, 10);
    const again = [cand("a", 1), cand("b", 2)];
    const second = planRun(again, first.nextState, 10);
    expect(second.records).toHaveLength(0);
    expect(second.unchanged).toBe(2);
    expect(again.every((c) => c.build.mock.calls.length === 0)).toBe(true);
  });

  it("re-emits only the source whose mtime and content changed", () => {
    const first = planRun([cand("a", 1), cand("b", 2)], EMPTY_STATE, 10);
    const second = planRun([cand("a", 1), cand("b", 3, "changed")], first.nextState, 10);
    expect(second.records.map((r) => r.source_id)).toEqual(["b"]);
  });

  it("does not re-emit when mtime moved but the digest is identical", () => {
    const first = planRun([cand("a", 1)], EMPTY_STATE, 10);
    const second = planRun([cand("a", 5)], first.nextState, 10);
    expect(second.records).toHaveLength(0);
    expect(second.nextState.entries["a"]?.mtime).toBe(5);
  });

  it("caps the run, defers the rest, and leaves deferred sources out of state", () => {
    const plan = planRun([cand("a", 3), cand("b", 2), cand("c", 1)], EMPTY_STATE, 2);
    expect(plan.records.map((r) => r.source_id)).toEqual(["a", "b"]);
    expect(plan.deferred).toBe(1);
    expect(plan.nextState.entries["c"]).toBeUndefined();
  });

  it("drops a record with a secret, reports only its label and patterns, and keeps it out of state", () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const plan = planRun([cand("leak", 2, `x ${secret}`), cand("ok", 1)], EMPTY_STATE, 10);
    expect(plan.records.map((r) => r.source_id)).toEqual(["ok"]);
    expect(plan.dropped).toEqual([{ label: "/path/leak", patterns: ["github-token"] }]);
    expect(plan.droppedKeys.has("leak")).toBe(true);
    expect(plan.nextState.entries["leak"]).toBeUndefined();
    expect(JSON.stringify(plan.dropped)).not.toContain(secret);
  });

  it("forgets state for sources that no longer exist", () => {
    const first = planRun([cand("a", 1), cand("gone", 1)], EMPTY_STATE, 10);
    const second = planRun([cand("a", 1)], first.nextState, 10);
    expect(Object.keys(second.nextState.entries)).toEqual(["a"]);
  });
});

describe("parseState", () => {
  it("falls back to empty on null, garbage, or a wrong version", () => {
    expect(parseState(null)).toEqual(EMPTY_STATE);
    expect(parseState("{oops")).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ version: 2, entries: {} }))).toEqual(EMPTY_STATE);
  });
  it("reads a valid state", () => {
    const s = { version: 1, entries: { a: { mtime: 1, hash: "h" } } };
    expect(parseState(JSON.stringify(s))).toEqual(s);
  });
});
