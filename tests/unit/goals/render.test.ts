/**
 * The standup message: legible without reading code, every reason printed with its own result, and split
 * at Telegram's limit rather than losing a row (CLAUDE.md #26).
 */

import { describe, it, expect } from "vitest";
import { renderStandup, goalLine, type RenderOptions } from "../../../src/goals/render.js";
import type { GoalEvaluation } from "../../../src/goals/evaluate.js";
import { CALLBACK_DATA_MAX_BYTES, decodeGoalCallback } from "../../../src/goals/callbacks.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";
import { TZ, makeGoal } from "../../helpers/goal-fixtures.js";
import type { GoalRow, Pace } from "../../../src/goals/types.js";

const TODAY = "2026-09-30";
const OPTS: RenderOptions = { heading: "Standup", today: TODAY, timeZone: TZ, mode: "standup" };

function evaluation(over: Omit<Partial<GoalEvaluation>, "goal"> & { goal?: Partial<GoalRow> } = {}): GoalEvaluation {
  const { goal: goalOver, ...rest } = over;
  return {
    goal: makeGoal({ title: "A goal", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 5, ...goalOver }),
    number: 1,
    blockedNow: false,
    unblockedNow: false,
    outcome: { ok: true, value: 0, evidence: "0 applications" },
    value: 0,
    evidence: "0 applications",
    error: null,
    pace: "behind" as Pace,
    completed: false,
    ...rest,
  };
}

describe("the plan's own example, character for character", () => {
  it("renders a behind goal, an on-track goal, and 'Blocked: none'", () => {
    const messages = renderStandup(
      [
        evaluation({ number: 1, goal: { title: "Tashi 5 NL applications/week", target: 5, due_on: "2026-10-31" }, value: 0, pace: "behind" }),
        evaluation({
          number: 2,
          goal: { title: "Dispatch loop ships 1 merged fix/week", target: 1, metric_key: "prs_merged_7d", metric_arg: "acme/api" },
          value: 1,
          pace: "on_track",
          outcome: { ok: true, value: 1, evidence: "1 pull request" },
        }),
      ],
      OPTS,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe(
      [
        "<b>Standup · Wed 30 Sep</b>",
        "1. Tashi 5 NL applications/week: 0 of 5 (need 5 more by 31 Oct, pace BEHIND)",
        "2. Dispatch loop ships 1 merged fix/week: 1 of 1 ✓ on track",
        "Blocked: none",
      ].join("\n"),
    );
  });

  it("offers Plan next step only on the goal that is behind", () => {
    const [message] = renderStandup(
      [
        evaluation({ number: 1, pace: "behind" }),
        evaluation({ number: 2, pace: "on_track", value: 5 }),
        evaluation({ number: 3, pace: "ahead", value: 9 }),
      ],
      OPTS,
    );
    expect(message!.keyboard.flat().map((b) => b.text)).toEqual(["Plan next step · 1"]);
  });
});

describe("goalLine", () => {
  it("shows how much is still needed, and the due date, for a goal behind pace", () => {
    const line = goalLine(evaluation({ goal: { target: 12, due_on: "2026-10-31" }, value: 4.5, pace: "behind" }), TODAY);
    expect(line).toBe("1. A goal: 4.5 of 12 (need 7.5 more by 31 Oct, pace BEHIND)");
  });

  it("says a due day is today, and a missed one is past due, with the date", () => {
    expect(goalLine(evaluation({ goal: { target: 5, due_on: TODAY }, value: 3 }), TODAY)).toContain("due today");
    const past = goalLine(evaluation({ goal: { target: 5, due_on: "2026-09-20" }, value: 3 }), TODAY);
    expect(past).toContain("PAST DUE");
    expect(past).toContain("20 Sep");
  });

  it("says why a pace is unknown instead of inventing one", () => {
    const line = goalLine(evaluation({ goal: { metric_key: "manual", metric_arg: null, target: 100 }, value: 40, pace: "unknown" }), TODAY);
    expect(line).toBe("1. A goal: 40 of 100 (pace unknown: no due date)");
  });

  it("prints 'metric unavailable: <reason>' with the reason, never a 0", () => {
    const line = goalLine(
      evaluation({ outcome: { ok: false, error: "GitHub rejected the token (HTTP 401). Fix: replace GITHUB_TOKEN." }, value: null, evidence: "", error: "GitHub rejected the token (HTTP 401). Fix: replace GITHUB_TOKEN.", pace: "unknown" }),
      TODAY,
    );
    expect(line).toBe("1. A goal: metric unavailable: GitHub rejected the token (HTTP 401). Fix: replace GITHUB_TOKEN.");
    expect(line).not.toMatch(/ 0 of /);
  });

  it("marks a reached target done with its evidence in standup mode, and only says it will be, in list mode", () => {
    const done = evaluation({ goal: { title: "Reach 5k", target: 5000, metric_key: "manual", metric_arg: null }, value: 5200, completed: true, evidence: "reported as 5,200 on 2026-09-29", pace: "on_track" });
    expect(goalLine(done, TODAY)).toBe("✅ 1. Reach 5k: reached 5,200 of 5,000 — marked done (reported as 5,200 on 2026-09-29)");
    expect(goalLine(done, TODAY, "list")).toBe("1. Reach 5k: 5,200 of 5,000 ✓ target reached (the next standup marks it done)");
  });

  it("escapes the founder's title for HTML so one & or < cannot cost him the whole message", () => {
    const line = goalLine(evaluation({ goal: { title: "Ship <fast> & well" } }), TODAY);
    expect(line).toContain("Ship &lt;fast&gt; &amp; well");
    expect(line).not.toContain("<fast>");
  });

  it("flags a goal whose block just ended", () => {
    expect(goalLine(evaluation({ unblockedNow: true }), TODAY).startsWith("🔓 ")).toBe(true);
  });
});

describe("the Blocked section", () => {
  const blocked = (n: number, over: Partial<GoalRow> = {}) =>
    evaluation({
      number: n,
      blockedNow: true,
      outcome: null,
      value: null,
      evidence: "blocked until 2026-10-15",
      pace: "unknown",
      goal: { title: "Renew permit", status: "blocked", blocker: "waiting on the IND decision", blocked_until: new Date("2026-10-14T22:00:00Z"), ...over },
    });

  it("lists each blocked goal with its number, reason and end date, and computes no pace", () => {
    const [message] = renderStandup([evaluation({ number: 1 }), blocked(2)], OPTS);
    expect(message!.text).toContain("Blocked:\n• 2. Renew permit — waiting on the IND decision (until 15 Oct)");
    expect(message!.text).not.toContain("Blocked: none");
    expect(message!.text.split("\n").filter((l) => l.includes("Renew permit"))).toHaveLength(1);
  });

  it("says an open-ended block is open-ended and a missing reason is missing", () => {
    const [message] = renderStandup([blocked(1, { blocked_until: null, blocker: null })], OPTS);
    expect(message!.text).toContain("• 1. Renew permit — no reason recorded (no end date)");
  });

  it("gives a blocked goal no Plan next step button", () => {
    const [message] = renderStandup([blocked(1)], OPTS);
    expect(message!.keyboard).toEqual([]);
  });
});

describe("splitting at Telegram's limit — every goal, once", () => {
  const many = (n: number): GoalEvaluation[] =>
    Array.from({ length: n }, (_, i) =>
      evaluation({
        number: i + 1,
        goal: { title: `Goal ${i + 1} ${"t".repeat(160)}` },
        outcome: { ok: false, error: `GitHub rejected the token (HTTP 401). Fix: replace GITHUB_TOKEN on the server with a valid token that can read owner/repo-${i + 1}.` },
        value: null,
        evidence: "",
        error: "x",
        pace: "unknown",
      }),
    );

  it("puts 15 long goals into more than one message, each inside the limit", () => {
    const messages = renderStandup(many(15), OPTS);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it("shows every goal exactly once across the messages, with its own number", () => {
    const messages = renderStandup(many(15), OPTS);
    const all = messages.map((m) => m.text).join("\n");
    for (let n = 1; n <= 15; n++) {
      expect(all.split(`\n${n}. Goal ${n} `).length - 1, `goal ${n}`).toBe(1);
    }
    const ids = messages.flatMap((m) => m.goalIds);
    expect(new Set(ids).size).toBe(15);
    expect(ids).toHaveLength(15);
  });

  it("numbers the parts so the founder knows there is more, and repeats the date", () => {
    const messages = renderStandup(many(15), OPTS);
    messages.forEach((m, i) => expect(m.text.split("\n")[0]).toBe(`<b>Standup · Wed 30 Sep (${i + 1}/${messages.length})</b>`));
  });

  it("keeps a single message unnumbered", () => {
    const [only] = renderStandup(many(2), OPTS);
    expect(only!.text.split("\n")[0]).toBe("<b>Standup · Wed 30 Sep</b>");
  });

  it("puts each goal's button in the message that shows that goal, never more than one per goal", () => {
    const messages = renderStandup(many(15), OPTS);
    const buttons = messages.flatMap((m) => m.keyboard.flat());
    expect(buttons).toHaveLength(15);
    for (const m of messages) {
      const fromKeyboard = m.keyboard.flat().map((b) => (decodeGoalCallback(b.callback_data) as { goalId: string }).goalId);
      expect(fromKeyboard.sort()).toEqual([...m.goalIds].sort());
    }
  });

  it("keeps every callback payload inside Telegram's 64 bytes", () => {
    for (const m of renderStandup(many(15), OPTS)) {
      for (const b of m.keyboard.flat()) expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it("marks a continuation when some goals were already delivered by an earlier run", () => {
    const [m] = renderStandup(many(2), { ...OPTS, continued: true });
    expect(m!.text.split("\n")[0]).toBe("<b>Standup · Wed 30 Sep (continued)</b>");
  });
});

describe("empty and list mode", () => {
  it("renders nothing at all for no goals: an empty standup is never sent", () => {
    expect(renderStandup([], OPTS)).toEqual([]);
  });

  it("titles the same body 'Goals' for the /goals view", () => {
    const [m] = renderStandup([evaluation()], { ...OPTS, heading: "Goals", mode: "list" });
    expect(m!.text.split("\n")[0]).toBe("<b>Goals · Wed 30 Sep</b>");
  });
});
