import { describe, it, expect } from "vitest";
import {
  makeRepeatGuard,
  canonicalToolKey,
  repeatGuardBlockMessage,
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

describe("repeatGuardBlockMessage — honest loop-awareness (rule #19/#24)", () => {
  it("names the looping tool and forbids re-calling it", () => {
    const msg = repeatGuardBlockMessage("read_emails", "emails");
    expect(msg).toContain("read_emails");
    expect(msg).toContain("Do NOT call read_emails again");
    expect(msg).toContain("emails");
  });

  it("tells the model to be honest instead of claiming a false completion", () => {
    const msg = repeatGuardBlockMessage("search_web", "search results");
    // The message must push toward an honest "here's what's missing", never a fake done.
    expect(msg).toContain("going in circles");
    expect(msg.toLowerCase()).toContain("do not claim the task is complete");
    expect(msg).toContain("what is missing");
  });

  it("falls back to a generic data label when none is given", () => {
    const msg = repeatGuardBlockMessage("list_dir");
    expect(msg).toContain("results");
    expect(msg).toContain("list_dir");
  });
});
