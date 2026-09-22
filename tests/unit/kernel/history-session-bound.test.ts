/**
 * Conversation history must be bounded by TIME, not only by turn count.
 *
 * THE INCIDENT (2026-09-21 07:23, production). The founder sent:
 *
 *   "Create a GitHub issue in FounderOS to add a visible test comment to the
 *    bottom of the README.md file, and explicitly label it agent:ready so the
 *    VPS dispatcher picks it up"
 *
 * FounderOS called `update_context`, rewrote his persistent business context, and
 * replied "I have recorded your preference into your business context. Going
 * forward … FounderOS will ensure a PDF format is produced and delivered." No
 * issue was filed. Sixteen minutes later he wrote the dispatch brief by hand.
 *
 * The PDF instruction was real — he gave it on 2026-09-16 17:13 ("I needed a pdf
 * for it. Remember this from next time also"). It was still in the replayed
 * conversation **4 days and 14 hours later**, because history was capped at 20
 * turns and 16k chars and at nothing else. The 20 turns preceding the misroute
 * began on 2026-09-16 17:59: a 4.5-DAY "conversation" presented to the planner as
 * the immediate context of a message about a GitHub issue.
 *
 * A count cap cannot express "we stopped talking". On one long-lived Telegram
 * thread — which is how the founder actually uses this — a quiet cap means every
 * morning's first message is planned against whatever was said last week.
 *
 * The bound is a SESSION GAP, not an absolute age: a continuous working session
 * keeps its full history however long it runs, so "send it" and "that draft" still
 * resolve; a silence longer than the gap starts a fresh conversation. The failure
 * direction is deliberate — after a long gap the bot asks what "it" refers to
 * (loud, cheap) instead of inventing an action from stale context (silent,
 * mutates founder state).
 */

import { describe, expect, it } from "vitest";
import {
  trimHistory,
  HISTORY_MAX_TURNS,
  HISTORY_MAX_CHARS,
  HISTORY_SESSION_GAP_MS,
} from "../../../src/kernel/state.js";
import type { TurnSummary } from "../../../src/kernel/contracts.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function turn(atMs: number, input = "hi", reply = "ok"): TurnSummary {
  return {
    turn_id: `t${atMs}`,
    at: new Date(atMs).toISOString(),
    user_input: input,
    goal: input,
    outcome: "replied",
    reply,
  };
}

/** Turns spaced `gapMs` apart, oldest first, ending at `endMs`. */
function series(count: number, gapMs: number, endMs: number): TurnSummary[] {
  return Array.from({ length: count }, (_, i) => turn(endMs - (count - 1 - i) * gapMs));
}

describe("trimHistory — session gap bound", () => {
  const now = Date.parse("2026-09-21T07:23:00.000Z");

  it("drops everything before a silence longer than the session gap", () => {
    const stale = turn(now - 4.5 * 24 * HOUR, "I needed a pdf for it. Remember this from next time also.");
    const current = turn(now, "Create a GitHub issue in FounderOS…");

    const kept = trimHistory([stale, current]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.user_input).toMatch(/GitHub issue/);
  });

  it("keeps a continuous working session intact, however many hours it spans", () => {
    // 12 turns, 30 min apart — 5.5 hours of continuous work, no gap exceeded.
    const kept = trimHistory(series(12, 30 * MINUTE, now));
    expect(kept).toHaveLength(12);
  });

  it("cuts at the MOST RECENT gap, not the oldest one", () => {
    const history = [
      turn(now - 40 * HOUR, "week-old thing"),
      turn(now - 39 * HOUR, "still old"),
      turn(now - 2 * HOUR, "this morning"),
      turn(now - 1 * HOUR, "follow-up"),
      turn(now, "send it"),
    ];

    const kept = trimHistory(history);

    expect(kept.map((t) => t.user_input)).toEqual(["this morning", "follow-up", "send it"]);
  });

  it("keeps history across a gap just UNDER the threshold", () => {
    const justUnder = HISTORY_SESSION_GAP_MS - MINUTE;
    const kept = trimHistory([turn(now - justUnder, "earlier"), turn(now, "later")]);
    expect(kept).toHaveLength(2);
  });

  it("cuts at a gap exactly ON the threshold", () => {
    const kept = trimHistory([turn(now - HISTORY_SESSION_GAP_MS, "earlier"), turn(now, "later")]);
    expect(kept).toHaveLength(1);
  });

  /**
   * An unreadable timestamp carries no gap information. Cutting on it would wipe
   * history silently — the same silent-failure direction this bound exists to
   * remove — so a bad `at` is never itself a reason to cut. The turn and char
   * caps still bound the list.
   */
  it("does not cut on an unparseable timestamp", () => {
    const broken = { ...turn(now - HOUR, "earlier"), at: "not-a-date" };
    expect(trimHistory([broken, turn(now, "later")])).toHaveLength(2);
  });

  it("never empties the list, even when every turn is ancient", () => {
    const kept = trimHistory([turn(now - 90 * 24 * HOUR), turn(now - 60 * 24 * HOUR)]);
    expect(kept.length).toBeGreaterThanOrEqual(1);
  });

  it("handles an empty history", () => {
    expect(trimHistory([])).toEqual([]);
  });
});

describe("trimHistory — existing caps still hold", () => {
  const now = Date.parse("2026-09-21T07:23:00.000Z");

  it("caps a long continuous session at HISTORY_MAX_TURNS", () => {
    const kept = trimHistory(series(HISTORY_MAX_TURNS + 15, MINUTE, now));
    expect(kept).toHaveLength(HISTORY_MAX_TURNS);
  });

  it("caps on total chars, keeping the newest", () => {
    const big = "x".repeat(5_000);
    const kept = trimHistory(series(10, MINUTE, now).map((t) => ({ ...t, user_input: big, reply: big })));

    const chars = kept.reduce((n, t) => n + t.user_input.length + t.reply.length, 0);
    expect(chars).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(kept.at(-1)!.turn_id).toBe(`t${now}`);
  });
});
