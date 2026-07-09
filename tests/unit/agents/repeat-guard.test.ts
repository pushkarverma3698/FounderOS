import { describe, it, expect } from "vitest";
import {
  makeRepeatGuard,
  canonicalToolKey,
  makeThreadScopedRegistry,
} from "../../../src/agents/agent-tools/repeat-guard.js";

describe("repeat-guard — github list_repos loop (T04 live 2026-06-29)", () => {
  it("blocks the 3rd identical call within the window (caps real API at 2)", () => {
    const g = makeRepeatGuard({ maxRepeats: 3, windowMs: 90_000, now: () => 1000 });
    const input = { action: "list_repos", owner: "pushkarverma3698" };
    expect(g.shouldBlock("github_read", input)).toBe(false); // 1st → real call
    expect(g.shouldBlock("github_read", input)).toBe(false); // 2nd → real call
    expect(g.shouldBlock("github_read", input)).toBe(true); //  3rd → STOP
    expect(g.shouldBlock("github_read", input)).toBe(true); //  4th → still STOP
  });

  it("treats key-order / null-vs-absent inputs as the same call", () => {
    const a = canonicalToolKey("github_read", { action: "list_repos", owner: "x", repo: null });
    const b = canonicalToolKey("github_read", { owner: "x", action: "list_repos" });
    expect(a).toBe(b);
  });

  it("does NOT block a different input (genuine progress)", () => {
    const g = makeRepeatGuard({ maxRepeats: 3, windowMs: 90_000, now: () => 1000 });
    g.shouldBlock("github_read", { action: "list_repos" });
    g.shouldBlock("github_read", { action: "list_repos" });
    expect(g.shouldBlock("github_read", { action: "list_commits", repo: "x" })).toBe(false);
  });

  it("resets after the window expires (a legit later call is never blocked)", () => {
    let t = 1000;
    const g = makeRepeatGuard({ maxRepeats: 3, windowMs: 90_000, now: () => t });
    const input = { action: "list_repos" };
    g.shouldBlock("github_read", input);
    g.shouldBlock("github_read", input);
    expect(g.shouldBlock("github_read", input)).toBe(true); // 3rd blocks
    t = 1000 + 200_000; // hours later
    expect(g.shouldBlock("github_read", input)).toBe(false); // fresh streak
  });

  it("scopes per tool name", () => {
    const g = makeRepeatGuard({ maxRepeats: 3, windowMs: 90_000, now: () => 1000 });
    g.shouldBlock("github_read", { action: "list_repos" });
    g.shouldBlock("github_read", { action: "list_repos" });
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
      makeRepeatGuard({ maxRepeats: 3, windowMs: 90_000, now: () => 1000 }),
    );
    const input = { action: "list_repos" };

    const threadA = registry.get("turicks:111");
    threadA.shouldBlock("github_read", input); // 1st
    threadA.shouldBlock("github_read", input); // 2nd
    expect(threadA.shouldBlock("github_read", input)).toBe(true); // 3rd → blocked for A

    // Thread B's first identical call must NOT be pre-blocked by A's history.
    const threadB = registry.get("turicks:222");
    expect(threadB.shouldBlock("github_read", input)).toBe(false);
  });

  it("returns the SAME instance for repeated lookups of the same thread (state persists within a turn)", () => {
    const registry = makeThreadScopedRegistry(() => makeRepeatGuard({ now: () => 1000 }));
    const first = registry.get("turicks:111");
    const second = registry.get("turicks:111");
    expect(first).toBe(second);
  });

  it("falls back to a single shared instance when threadId is undefined (never crashes)", () => {
    const registry = makeThreadScopedRegistry(() => makeRepeatGuard({ now: () => 1000 }));
    const a = registry.get(undefined);
    const b = registry.get(undefined);
    expect(a).toBe(b);
  });
});
