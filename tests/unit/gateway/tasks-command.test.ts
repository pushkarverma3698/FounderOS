import { describe, it, expect, vi } from "vitest";
import {
  stateFromLabels,
  formatAge,
  formatTasksMessage,
  selectRenderedRows,
  MAX_RENDERED_ROWS,
  handleTasks,
  isPrBrainReviewed,
  isGreenCI,
  fetchDispatchTasks,
  type TasksView,
  type TaskRow,
  type ReadyMergePr,
} from "../../../src/gateway/tasks-command.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  repo: "OplifyMessage/oplify-messaging-app",
  issue: 32,
  title: "fix the flaky CSV export",
  state: "working",
  url: "https://github.com/OplifyMessage/oplify-messaging-app/issues/32",
  ageMinutes: 4,
  ...over,
});

const readyPr = (over: Partial<ReadyMergePr> = {}): ReadyMergePr => ({
  repo: "pushkarverma3698/FounderOS",
  prNumber: 801,
  title: "add 'Ready for you to merge' section to /tasks",
  url: "https://github.com/pushkarverma3698/FounderOS/pull/801",
  ...over,
});

describe("stateFromLabels", () => {
  it("reads the agent lifecycle label", () => {
    expect(stateFromLabels(["antigravity", "agent:review"])).toBe("review");
  });

  it("is case-insensitive — GitHub preserves whatever case created the label", () => {
    expect(stateFromLabels(["Agent:Blocked"])).toBe("blocked");
  });

  it("returns null for an issue that is not in the loop at all", () => {
    expect(stateFromLabels(["bug", "help wanted"])).toBeNull();
  });

  it("prefers the earliest lifecycle state when an issue carries two", () => {
    // A mislabelled issue must not be reported as further along than it is.
    expect(stateFromLabels(["agent:review", "agent:ready"])).toBe("ready");
  });
});

describe("isPrBrainReviewed", () => {
  it("returns true when a comment contains the pr-brain reviewed marker for the head SHA", () => {
    const comments = [
      "Starting review...",
      "<!-- brain-reviewed: a1b2c3d4e5f67890123456789012345678901234 -->\nAll checks passed.",
    ];
    expect(isPrBrainReviewed(comments, "a1b2c3d4e5f67890123456789012345678901234")).toBe(true);
  });

  it("matches when head SHA is short prefix or case insensitive", () => {
    const comments = ["<!-- brain-reviewed: A1B2C3D -->"];
    expect(isPrBrainReviewed(comments, "a1b2c3d4e5f67890123456789012345678901234")).toBe(true);
  });

  it("returns false when no comment has the reviewed marker for the target head SHA", () => {
    const comments = ["<!-- brain-reviewed: 9999999 -->", "LGTM"];
    expect(isPrBrainReviewed(comments, "a1b2c3d4e5f67890123456789012345678901234")).toBe(false);
  });
});

describe("isGreenCI", () => {
  it("returns true when check runs are completed and successful", async () => {
    const octokit = {
      rest: {
        checks: {
          listForRef: vi.fn().mockResolvedValue({
            data: {
              check_runs: [{ status: "completed", conclusion: "success" }],
            },
          }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({
            data: { state: "success", statuses: [] },
          }),
        },
      },
    } as never;

    const result = await isGreenCI(octokit, "owner", "repo", "sha123");
    expect(result).toBe(true);
  });

  it("returns false when a check run is incomplete or failed", async () => {
    const octokit = {
      rest: {
        checks: {
          listForRef: vi.fn().mockResolvedValue({
            data: {
              check_runs: [{ status: "in_progress", conclusion: null }],
            },
          }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({
            data: { state: "pending", statuses: [] },
          }),
        },
      },
    } as never;

    const result = await isGreenCI(octokit, "owner", "repo", "sha123");
    expect(result).toBe(false);
  });
});

describe("formatAge", () => {
  it("renders minutes, hours and days at the right scale", () => {
    expect(formatAge(4)).toBe("4m");
    expect(formatAge(130)).toBe("2h 10m");
    expect(formatAge(120)).toBe("2h");
    expect(formatAge(60 * 24 * 4)).toBe("4d");
  });

  it("never renders a negative age from clock skew", () => {
    expect(formatAge(-5)).toBe("0m");
  });
});

describe("formatTasksMessage", () => {
  it("tells the founder what to type when the queue is empty", () => {
    // "No output" is the fastest way to teach someone a command is broken.
    const msg = formatTasksMessage({ rows: [], readyToMerge: [], unreachable: [] });
    expect(msg).toContain("Nothing in flight");
    expect(msg).toContain("/task repo:app");
  });

  it("renders 'Ready for you to merge' section when non-draft open PRs with green CI and review are present", () => {
    const msg = formatTasksMessage({
      rows: [],
      readyToMerge: [readyPr()],
      unreachable: [],
    });
    expect(msg).toContain("Ready for you to merge");
    expect(msg).toContain("#801");
    expect(msg).toContain("FounderOS");
    expect(msg).toContain("add 'Ready for you to merge' section to /tasks");
    expect(msg).toContain("https://github.com/pushkarverma3698/FounderOS/pull/801");
  });

  it("groups rows by state and explains what each state means", () => {
    const msg = formatTasksMessage({
      rows: [row({ state: "ready", issue: 41 }), row({ state: "blocked", issue: 42 })],
      readyToMerge: [],
      unreachable: [],
    });
    expect(msg).toContain("queued");
    expect(msg).toContain("needs you");
    expect(msg).toContain("#41");
    expect(msg).toContain("#42");
  });

  it("leads with a count per state and ready to merge PRs", () => {
    const msg = formatTasksMessage({
      rows: [row({ state: "failed", issue: 1 }), row({ state: "failed", issue: 2 }), row({ state: "blocked", issue: 3 })],
      readyToMerge: [readyPr({ prNumber: 800 })],
      unreachable: [],
    });
    expect(msg.split("\n")[1]).toContain("1 ready to merge");
    expect(msg.split("\n")[1]).toContain("2 failed");
    expect(msg.split("\n")[1]).toContain("1 blocked");
  });

  it("PRINTS an unreachable repository instead of showing it as empty", () => {
    const msg = formatTasksMessage({
      rows: [],
      readyToMerge: [],
      unreachable: [{ repo: "OplifyMessage/oplify-messaging-api", error: "Bad credentials" }],
    });
    expect(msg).toContain("could not be read");
    expect(msg).toContain("Bad credentials");
  });

  it("escapes a title that would otherwise break the HTML message", () => {
    const msg = formatTasksMessage({
      rows: [row({ title: "fix <script> & spans" })],
      readyToMerge: [readyPr({ title: "feat: add <PR> & links" })],
      unreachable: [],
    });
    expect(msg).toContain("&lt;script&gt;");
    expect(msg).toContain("&lt;PR&gt;");
    expect(msg).toContain("&amp;");
  });

  it("stays inside Telegram's message limit with a full queue", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ issue: i, title: `task number ${i} with a fairly long descriptive title` }),
    );
    expect(formatTasksMessage({ rows, readyToMerge: [readyPr()], unreachable: [] }).length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  it("says how many rows it dropped and which states they were in", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ issue: i, state: "ready" }));
    const msg = formatTasksMessage({ rows, readyToMerge: [], unreachable: [] });
    expect(msg).toContain("more not shown (ready)");
  });
});

describe("selectRenderedRows", () => {
  it("keeps everything when the queue fits", () => {
    const rows = [row(), row({ issue: 2 })];
    expect(selectRenderedRows(rows).hidden).toHaveLength(0);
  });

  it("keeps the rows that need a human over the rows that need nobody", () => {
    const rows = [
      ...Array.from({ length: MAX_RENDERED_ROWS + 5 }, (_, i) => row({ issue: 100 + i, state: "ready" })),
      row({ issue: 7, state: "blocked" }),
    ];
    const { shown, hidden } = selectRenderedRows(rows);
    expect(shown.map((r) => r.issue)).toContain(7);
    expect(hidden.every((r) => r.state === "ready")).toBe(true);
  });
});

describe("fetchDispatchTasks", () => {
  it("returns empty readyToMerge and unreachable when GITHUB_TOKEN is missing", async () => {
    const orig = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      const res = await fetchDispatchTasks(["pushkarverma3698/FounderOS"]);
      expect(res.rows).toEqual([]);
      expect(res.readyToMerge).toEqual([]);
      expect(res.unreachable[0]?.error).toBe("GITHUB_TOKEN is not set");
    } finally {
      if (orig) process.env["GITHUB_TOKEN"] = orig;
    }
  });
});

describe("handleTasks", () => {
  it("still answers when the GitHub read throws outright", async () => {
    const sent: string[] = [];
    const ctx = { reply: async (text: string) => void sent.push(text) } as never;
    await handleTasks(ctx, {
      fetch: () => Promise.reject(new Error("socket hang up")),
    });
    expect(sent[0]).toContain("socket hang up");
  });

  it("renders the view it was given", async () => {
    const sent: string[] = [];
    const ctx = { reply: async (text: string) => void sent.push(text) } as never;
    const view: TasksView = { rows: [row({ issue: 99 })], readyToMerge: [readyPr()], unreachable: [] };
    await handleTasks(ctx, { fetch: () => Promise.resolve(view) });
    expect(sent[0]).toContain("#99");
    expect(sent[0]).toContain("#801");
  });
});

