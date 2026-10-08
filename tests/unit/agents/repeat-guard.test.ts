import { describe, it, expect } from "vitest";
import {
  makeRepeatGuard,
  canonicalToolKey,
  makeThreadScopedRegistry,
  repeatGuardScope,
} from "../../../src/agents/agent-tools/repeat-guard.js";

describe("repeat-guard — github list_repos loop (T04 live 2026-06-29)", () => {
  it("blocks the 4th identical call (caps real API at 3)", () => {
    const g = makeRepeatGuard({ maxRepeats: 3 });
    const input = { action: "list_repos", owner: "pushkarverma3698" };
    expect(g.shouldBlock("github_read", input)).toBe(false); // 1st → real call
    expect(g.shouldBlock("github_read", input)).toBe(false); // 2nd → real call
    expect(g.shouldBlock("github_read", input)).toBe(false); // 3rd → real call
    expect(g.shouldBlock("github_read", input)).toBe(true); //  4th → STOP
    expect(g.shouldBlock("github_read", input)).toBe(true); //  5th → still STOP
  });

  it("treats key-order / null-vs-absent inputs as the same call", () => {
    const a = canonicalToolKey("github_read", { action: "list_repos", owner: "x", repo: null });
    const b = canonicalToolKey("github_read", { owner: "x", action: "list_repos" });
    expect(a).toBe(b);
  });

  it("does NOT block a different input (genuine progress)", () => {
    const g = makeRepeatGuard({ maxRepeats: 3 });
    for (let i = 0; i < 4; i++) g.shouldBlock("github_read", { action: "list_repos" });
    expect(g.shouldBlock("github_read", { action: "list_commits", repo: "x" })).toBe(false);
  });

  it("scopes per tool name", () => {
    const g = makeRepeatGuard({ maxRepeats: 3 });
    for (let i = 0; i < 4; i++) g.shouldBlock("github_read", { action: "list_repos" });
    expect(g.shouldBlock("search_web", { action: "list_repos" })).toBe(false);
  });
});

// ── makeThreadScopedRegistry (cross-thread contamination fix, 2026-06-30) ────
//
// Bug: engineering.ts used to create ONE repeat-guard and ONE failure-counter
// at module scope, shared by every conversation thread for the life of the
// process (the office graph is compiled once — rule #2 — so that module-level
// state lives forever). A burst of identical github_read calls in thread A
// could pre-block a genuinely fresh call in thread B if both happened inside
// the same 90s window, silently violating rule #20 (context isolation across
// every graph boundary) — the loop-guard itself was a leakage point.

describe("makeThreadScopedRegistry — per-thread isolation", () => {
  it("gives two different threads independent repeat-guard instances", () => {
    const registry = makeThreadScopedRegistry(() =>
      makeRepeatGuard({ maxRepeats: 3 }),
    );
    const input = { action: "list_repos" };

    const threadA = registry.get("turicks:111");
    threadA.shouldBlock("github_read", input); // 1st
    threadA.shouldBlock("github_read", input); // 2nd
    threadA.shouldBlock("github_read", input); // 3rd
    expect(threadA.shouldBlock("github_read", input)).toBe(true); // 4th → blocked for A

    // Thread B's first identical call must NOT be pre-blocked by A's history.
    const threadB = registry.get("turicks:222");
    expect(threadB.shouldBlock("github_read", input)).toBe(false);
  });

  it("returns the SAME instance for repeated lookups of the same thread (state persists within a turn)", () => {
    const registry = makeThreadScopedRegistry(() => makeRepeatGuard());
    const first = registry.get("turicks:111");
    const second = registry.get("turicks:111");
    expect(first).toBe(second);
  });

  it("falls back to a single shared instance when threadId is undefined (never crashes)", () => {
    const registry = makeThreadScopedRegistry(() => makeRepeatGuard());
    const a = registry.get(undefined);
    const b = registry.get(undefined);
    expect(a).toBe(b);
  });
});

describe("repeatGuardScope + registry cap (AG-046)", () => {
  it("keys by thread + step scope, falling back to the bare thread id", () => {
    expect(repeatGuardScope({ configurable: { thread_id: "t", step_scope: "turn1:s1" } })).toBe("t|turn1:s1");
    expect(repeatGuardScope({ configurable: { thread_id: "t" } })).toBe("t");
    expect(repeatGuardScope(undefined)).toBeUndefined();
  });

  it("evicts the least recently used scope beyond the cap, so the map cannot grow forever", () => {
    const registry = makeThreadScopedRegistry(() => makeRepeatGuard(), 3);
    const first = registry.get("a");
    registry.get("b");
    registry.get("c");
    registry.get("a"); // touch a: b is now the oldest
    registry.get("d"); // evicts b
    expect(registry.get("a")).toBe(first);
    const c = registry.get("c");
    registry.get("b"); // b was evicted: a fresh instance, which evicts the oldest again
    expect(registry.get("c")).toBe(c);
  });
});
