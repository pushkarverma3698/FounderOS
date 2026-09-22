/**
 * Unit tests — /tasks, the engineering loop's only visible state.
 *
 * The behaviour worth defending: an unreadable repository is PRINTED, never
 * silently treated as an empty one. A repo whose token expired and a repo with
 * no work in it produce identical output otherwise, and that ambiguity is
 * exactly how the dead review→fix arrow stayed hidden for days while issue #710
 * sat at agent:review with nobody dispatching it.
 */

import { describe, it, expect } from "vitest";
import {
  stateFromLabels,
  formatAge,
  formatTasksMessage,
  selectRenderedRows,
  MAX_RENDERED_ROWS,
  handleTasks,
  type TasksView,
  type TaskRow,
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
    const msg = formatTasksMessage({ rows: [], unreachable: [] });
    expect(msg).toContain("Nothing in flight");
    expect(msg).toContain("/task repo:app");
  });

  it("groups rows by state and explains what each state means", () => {
    const msg = formatTasksMessage({
      rows: [row({ state: "ready", issue: 41 }), row({ state: "blocked", issue: 42 })],
      unreachable: [],
    });
    expect(msg).toContain("queued");
    expect(msg).toContain("needs you");
    expect(msg).toContain("#41");
    expect(msg).toContain("#42");
  });

  it("PRINTS an unreachable repository instead of showing it as empty", () => {
    const msg = formatTasksMessage({
      rows: [],
      unreachable: [{ repo: "OplifyMessage/oplify-messaging-api", error: "Bad credentials" }],
    });
    expect(msg).toContain("could not be read");
    expect(msg).toContain("Bad credentials");
  });

  it("escapes a title that would otherwise break the HTML message", () => {
    const msg = formatTasksMessage({ rows: [row({ title: "fix <script> & spans" })], unreachable: [] });
    expect(msg).toContain("&lt;script&gt;");
    expect(msg).toContain("&amp;");
  });

  it("stays inside Telegram's message limit with a full queue", () => {
    // Telegram hard-fails an over-length message, so /tasks would answer NOTHING
    // at exactly the moment the queue is most interesting. Measured before the
    // cap existed: 40 rows rendered 5,638 of a 4,096 budget.
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ issue: i, title: `task number ${i} with a fairly long descriptive title` }),
    );
    expect(formatTasksMessage({ rows, unreachable: [] }).length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  it("says how many rows it dropped and which states they were in", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ issue: i, state: "ready" }));
    const msg = formatTasksMessage({ rows, unreachable: [] });
    expect(msg).toContain("more not shown (ready)");
  });
});

describe("selectRenderedRows", () => {
  it("keeps everything when the queue fits", () => {
    const rows = [row(), row({ issue: 2 })];
    expect(selectRenderedRows(rows).hidden).toHaveLength(0);
  });

  it("keeps the rows that need a human over the rows that need nobody", () => {
    // A truncated list sorted by arrival reports the least interesting rows by
    // construction: agent:ready is the state waiting on nothing, and it is also
    // the one that would fill the message first.
    const rows = [
      ...Array.from({ length: MAX_RENDERED_ROWS + 5 }, (_, i) => row({ issue: 100 + i, state: "ready" })),
      row({ issue: 7, state: "blocked" }),
    ];
    const { shown, hidden } = selectRenderedRows(rows);
    expect(shown.map((r) => r.issue)).toContain(7);
    expect(hidden.every((r) => r.state === "ready")).toBe(true);
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
    const view: TasksView = { rows: [row({ issue: 99 })], unreachable: [] };
    await handleTasks(ctx, { fetch: () => Promise.resolve(view) });
    expect(sent[0]).toContain("#99");
  });
});
