import { describe, it, expect } from "vitest";
import { makeRepeatGuard, canonicalToolKey } from "../../../src/agents/agent-tools/repeat-guard.js";

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
