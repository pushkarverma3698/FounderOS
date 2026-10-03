import { describe, it, expect } from "vitest";
import { summarizeRepo, resolveRepoArg, failingChecks, type RawRepoData } from "../../../src/tools/repo-status.js";
import { renderWhere, renderRepoSection } from "../../../src/tools/repo-status-render.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const lbl = (...names: string[]) => names.map((name) => ({ name }));

const raw = (over: Partial<RawRepoData> = {}): RawRepoData => ({
  slug: "o/r",
  mergedPrs: [
    { number: 1, title: "old", merged_at: day(9), html_url: "u1" },
    { number: 2, title: "new a", merged_at: day(1), html_url: "u2" },
    { number: 3, title: "new b", merged_at: day(3), html_url: "u3" },
    { number: 4, title: "closed unmerged", merged_at: null, html_url: "u4" },
  ],
  openPrs: [
    { number: 10, title: "pr ok", html_url: "p10", draft: false, checks: [{ conclusion: "success" }] },
    { number: 11, title: "pr red", html_url: "p11", draft: true, checks: [{ conclusion: "failure" }, { conclusion: "success" }] },
  ],
  openIssues: [
    { number: 20, title: "p0 bug", html_url: "i20", labels: lbl("priority:P0") },
    { number: 21, title: "working", html_url: "i21", labels: lbl("agent:working") },
    { number: 22, title: "needs brief", html_url: "i22", labels: lbl("agent:needs-brief") },
    { number: 23, title: "blocked one", html_url: "i23", labels: lbl("agent:blocked", "priority:P1") },
    { number: 24, title: "plain", html_url: "i24", labels: [] },
    { number: 25, title: "a pr", html_url: "i25", labels: [], pull_request: {} },
  ],
  ...over,
});

describe("summarizeRepo", () => {
  const s = summarizeRepo(raw(), NOW);
  it("counts only PRs merged in the last 7 days, newest first", () => {
    expect(s.done.count).toBe(2);
    expect(s.done.top.map((p) => p.number)).toEqual([2, 3]);
  });
  it("in flight = open PRs + agent:* issues that are not blocked", () => {
    expect(s.inFlight.openPrs).toHaveLength(2);
    expect(s.inFlight.agentIssues.map((i) => i.number)).toEqual([21]);
  });
  it("left excludes PRs and groups by priority", () => {
    expect(s.left.total).toBe(5);
    expect(s.left.byPriority["P0"]).toBe(1);
    expect(s.left.byPriority["P1"]).toBe(1);
    expect(s.left.byPriority["none"]).toBe(3);
  });
  it("blocked = needs-brief/blocked issues + PRs with failing checks", () => {
    expect(s.blocked.issues.map((i) => i.number)).toEqual([22, 23]);
    expect(s.blocked.failingPrs.map((p) => p.number)).toEqual([11]);
  });
  it("failingChecks treats failure/timed_out as failing, null as pending", () => {
    expect(failingChecks([{ conclusion: "timed_out" }])).toBe(true);
    expect(failingChecks([{ conclusion: null }, { conclusion: "success" }])).toBe(false);
    // concurrency-cancelled runs are superseded, not failures
    expect(failingChecks([{ conclusion: "cancelled" }])).toBe(false);
  });
});

describe("resolveRepoArg", () => {
  const repos = ["a/FounderOS", "b/oplify-messaging-app", "b/oplify-messaging-api"];
  it("empty returns all", () => expect(resolveRepoArg("", repos)).toEqual({ ok: true, repos }));
  it("exact name", () => expect(resolveRepoArg("founderos", repos)).toEqual({ ok: true, repos: ["a/FounderOS"] }));
  it("unique substring", () => expect(resolveRepoArg("hulda", ["a/House-of-Hulda", ...repos])).toEqual({ ok: true, repos: ["a/House-of-Hulda"] }));
  it("ambiguous or unknown lists valid names", () => {
    expect(resolveRepoArg("oplify", repos).ok).toBe(false);
    expect(resolveRepoArg("zzz", repos)).toEqual({ ok: false, valid: repos });
  });
});

describe("render", () => {
  it("shows every number from the summary", () => {
    const html = renderRepoSection(summarizeRepo(raw(), NOW));
    expect(html).toContain("Done (7d): 2");
    expect(html).toContain("Left: 5");
    expect(html).toContain("P0 1");
    expect(html).toContain("#11");
    expect(html).toContain("failing checks");
  });
  it("escapes HTML in titles", () => {
    const html = renderRepoSection(
      summarizeRepo(raw({ mergedPrs: [{ number: 9, title: "<b>x</b>", merged_at: day(1), html_url: "u" }] }), NOW),
    );
    expect(html).not.toContain("<b>x</b>");
  });
  it("reports unreachable repos instead of hiding them", () => {
    const out = renderWhere([], [{ repo: "o/bad", error: "404" }]).join("\n");
    expect(out).toContain("o/bad");
    expect(out).toContain("404");
  });
  it("renderWhere returns sections under 4096 chars", () => {
    const many = Array.from({ length: 4 }, () => summarizeRepo(raw(), NOW));
    for (const part of renderWhere(many, [])) expect(part.length).toBeLessThan(4096);
  });
});
