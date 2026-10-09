import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// /tasks must list EVERY open agent:* issue. Live miss (2026-10-09): Oplify #115 and
// FounderOS #1030/#1005/#1004 did not appear. Two causes: states outside the five
// lifecycle labels (agent:spec, agent:spec-review, agent:needs-brief) were dropped, and
// only the first 50 open issues of a repo were read.
const gh = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("octokit", () => ({ Octokit: vi.fn(() => gh.client) }));
import {
  stateFromLabels,
  fetchDispatchTasks,
  formatTasksMessage,
} from "../../../src/gateway/tasks-command.js";

interface FakeIssue {
  number: number;
  labels: string[];
  pull_request?: object;
}

function fakeGitHub(issues: FakeIssue[]) {
  const all = issues.map((i) => ({
    number: i.number,
    title: `issue ${i.number}`,
    html_url: `https://github.com/o/r/issues/${i.number}`,
    updated_at: new Date().toISOString(),
    labels: i.labels.map((name) => ({ name })),
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  }));
  const listForRepo = vi.fn(async (p: { page?: number; per_page?: number }) => {
    const size = p.per_page ?? 30;
    const n = p.page ?? 1;
    return { data: all.slice((n - 1) * size, n * size) };
  });
  return {
    paginate: async (fn: (p: object) => Promise<{ data: unknown[] }>, params: { per_page?: number }) => {
      const out: unknown[] = [];
      for (let n = 1; ; n++) {
        const { data } = await fn({ ...params, page: n });
        out.push(...data);
        if (data.length < (params.per_page ?? 30)) return out;
      }
    },
    rest: {
      issues: { listForRepo, listComments: vi.fn().mockResolvedValue({ data: [] }) },
      pulls: { list: vi.fn().mockResolvedValue({ data: [] }), get: vi.fn() },
      checks: { listForRef: vi.fn() },
      repos: { getCombinedStatusForRef: vi.fn() },
    },
  };
}

describe("stateFromLabels — the pre-build states", () => {
  it("maps agent:spec and agent:spec-review to spec", () => {
    expect(stateFromLabels(["agent:spec"])).toBe("spec");
    expect(stateFromLabels(["agent:spec-review"])).toBe("spec");
  });

  it("maps agent:needs-brief to brief", () => {
    expect(stateFromLabels(["agent:needs-brief"])).toBe("brief");
  });

  it("keeps the lifecycle label ahead of a stale spec label", () => {
    expect(stateFromLabels(["agent:spec", "agent:working"])).toBe("working");
  });
});

describe("fetchDispatchTasks — coverage", () => {
  let orig: string | undefined;
  beforeEach(() => {
    orig = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "test-token";
  });
  afterEach(() => {
    if (orig === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = orig;
  });

  it("lists an agent issue that sits past the first 50 open issues", async () => {
    const plain: FakeIssue[] = Array.from({ length: 130 }, (_, i) => ({ number: 1000 - i, labels: ["bug"] }));
    gh.client = fakeGitHub([...plain, { number: 4, labels: ["agent:review"] }]);
    const res = await fetchDispatchTasks(["o/r"]);
    expect(res.rows.map((r) => r.issue)).toEqual([4]);
  });

  it("lists spec and needs-brief issues", async () => {
    gh.client = fakeGitHub([
      { number: 115, labels: ["agent:needs-brief"] },
      { number: 1030, labels: ["agent:spec-review"] },
    ]);
    const res = await fetchDispatchTasks(["o/r"]);
    expect(res.rows.map((r) => [r.issue, r.state]).sort()).toEqual([
      [1030, "spec"],
      [115, "brief"],
    ]);
  });

  it("renders the new states with a section each and tells the founder what they wait on", () => {
    const msg = formatTasksMessage({
      rows: [
        { repo: "o/r", issue: 115, title: "t", state: "brief", url: "u", ageMinutes: 5 },
        { repo: "o/r", issue: 1030, title: "t2", state: "spec", url: "u", ageMinutes: 5 },
      ],
      unreachable: [],
    });
    expect(msg).toContain("#115");
    expect(msg).toContain("#1030");
    expect(msg).toContain("1 brief");
    expect(msg).toContain("1 spec");
  });
});
