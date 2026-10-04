/**
 * recall_conversation — what the founder asked, found again in his own words.
 * ============================================================================
 * The planner replays only the current conversation, so "what did I ask you yesterday" had
 * no source before the turn log. These tests pin the three things that decide whether the
 * answer is believed:
 *   1. Time is read the way people say it ("yesterday", "last week", "Monday"), by code, not
 *      by a prompt — and an unreadable phrase is refused out loud, never guessed.
 *   2. The reply shows the founder's own words, a few at a time, with the range it actually
 *      searched, so a wrong reading is visible and correctable.
 *   3. An empty answer explains itself (what was searched, how far back memory goes) instead
 *      of reading like "you never said it".
 */

import { describe, it, expect } from "vitest";
import { recallConversation, resolveRecallWindow, type RecallDeps } from "../../../src/tools/recall-conversation.js";
import type { RecalledTurn, TurnQuery } from "../../../src/db/conversation-turns.js";

const TZ = "Asia/Kolkata";
/** Sun 4 Oct 2026, 15:30 IST. */
const NOW = new Date("2026-10-04T10:00:00Z");
/** Local midnight (IST) of a given date, as the UTC instant. */
const istMidnight = (iso: string): Date => new Date(`${iso}T00:00:00+05:30`);

const turn = (over: Partial<RecalledTurn> & { at: string }): RecalledTurn => ({
  turn_id: over.turn_id ?? `t-${over.at}`,
  occurred_at: new Date(over.at),
  user_input: "hello",
  goal: "greet",
  outcome: "replied",
  reply: "Hi.",
  ...over,
});

describe("resolveRecallWindow — time said the way people say it", () => {
  const win = (phrase: string) => resolveRecallWindow(phrase, NOW, TZ);

  it("today = local midnight to the next local midnight", () => {
    const w = win("today")!;
    expect(w.since).toEqual(istMidnight("2026-10-04"));
    expect(w.until).toEqual(istMidnight("2026-10-05"));
  });

  it("yesterday = the whole previous local day, not the previous 24 hours", () => {
    const w = win("yesterday")!;
    expect(w.since).toEqual(istMidnight("2026-10-03"));
    expect(w.until).toEqual(istMidnight("2026-10-04"));
    expect(w.label).toContain("Sat 3 Oct");
  });

  it("'last week' reaches back to the Monday of the previous week and runs to now, so a near-miss never hides the answer", () => {
    const w = win("last week")!;
    expect(w.since).toEqual(istMidnight("2026-09-21")); // Monday before the Monday (28 Sep) of this week
    expect(w.until).toEqual(istMidnight("2026-10-05"));
    expect(w.label).toContain("Mon 21 Sep");
  });

  it("'this week' starts on this week's Monday", () => {
    expect(win("this week")!.since).toEqual(istMidnight("2026-09-28"));
  });

  it("'last month' starts on the first of the previous month", () => {
    expect(win("last month")!.since).toEqual(istMidnight("2026-09-01"));
  });

  it("'N days ago' is that one local day", () => {
    const w = win("3 days ago")!;
    expect(w.since).toEqual(istMidnight("2026-10-01"));
    expect(w.until).toEqual(istMidnight("2026-10-02"));
  });

  it("'past N days' and 'a few days ago' run up to now", () => {
    expect(win("past 5 days")!.since).toEqual(istMidnight("2026-09-29"));
    expect(win("a few days ago")!.since).toEqual(istMidnight("2026-09-27"));
    expect(win("recently")!.until).toEqual(istMidnight("2026-10-05"));
  });

  it("a bare weekday is its most recent occurrence (today counts), 'last <weekday>' is strictly before today", () => {
    expect(win("monday")!.since).toEqual(istMidnight("2026-09-28"));
    expect(win("on sunday")!.since).toEqual(istMidnight("2026-10-04"));
    expect(win("last sunday")!.since).toEqual(istMidnight("2026-09-27"));
  });

  it("'this morning' is today before noon; 'last night' is yesterday 18:00 to today 06:00", () => {
    const m = win("this morning")!;
    expect(m.since).toEqual(istMidnight("2026-10-04"));
    expect(m.until).toEqual(new Date("2026-10-04T12:00:00+05:30"));
    const n = win("last night")!;
    expect(n.since).toEqual(new Date("2026-10-03T18:00:00+05:30"));
    expect(n.until).toEqual(new Date("2026-10-04T06:00:00+05:30"));
  });

  it("accepts an ISO date and an inclusive date range", () => {
    expect(win("2026-09-30")!.until).toEqual(istMidnight("2026-10-01"));
    const r = win("2026-09-28 to 2026-09-30")!;
    expect(r.since).toEqual(istMidnight("2026-09-28"));
    expect(r.until).toEqual(istMidnight("2026-10-01"));
  });

  it("ignores case and filler words", () => {
    expect(win("  On YESTERDAY ")!.since).toEqual(istMidnight("2026-10-03"));
  });

  describe("minutes and hours (\"what did I just ask you?\")", () => {
    const MIN = 60_000;
    const back = (minutes: number): Date => new Date(NOW.getTime() - minutes * MIN);

    it("'just now', 'a minute ago' and 'N minutes ago' look back at least half an hour and end now", () => {
      for (const phrase of ["just now", "a moment ago", "moments ago", "a minute ago", "5 minutes ago", "a few minutes ago", "about 10 minutes ago"]) {
        const w = win(phrase);
        expect(w, phrase).not.toBeNull();
        expect(w!.since, phrase).toEqual(back(30));
        expect(w!.until, phrase).toEqual(NOW);
      }
    });

    it("'an hour ago' and 'N hours ago' look back twice that far, so a loose guess still lands, and the label says so", () => {
      expect(win("an hour ago")!.since).toEqual(back(120));
      expect(win("an hour ago")!.label).toBe("the last 2 hours");
      expect(win("3 hours ago")!.since).toEqual(back(360));
      expect(win("a couple of hours ago")!.since).toEqual(back(240));
      expect(win("45 minutes ago")!.since).toEqual(back(90));
      expect(win("45 minutes ago")!.label).toBe("the last 90 minutes");
    });

    it("'past hour' and 'last 20 minutes' are exact spans up to now", () => {
      expect(win("in the last hour")!.since).toEqual(back(60));
      expect(win("past 2 hours")!.since).toEqual(back(120));
      expect(win("last 20 minutes")!.since).toEqual(back(20));
      expect(win("last 20 minutes")!.label).toBe("the last 20 minutes");
    });

    it("'earlier' and 'earlier today' are today", () => {
      for (const phrase of ["earlier", "earlier today"]) expect(win(phrase)!.since).toEqual(istMidnight("2026-10-04"));
    });

    it("'a couple of days ago' is two days ago", () => {
      expect(win("a couple of days ago")!.since).toEqual(istMidnight("2026-10-02"));
    });

    it("refuses an absurd span instead of guessing", () => {
      expect(win("500 hours ago")).toBeNull();
      expect(win("9999 minutes ago")).toBeNull();
    });
  });

  it("returns null for a phrase it cannot read, instead of guessing", () => {
    expect(win("sometime in the spring")).toBeNull();
    expect(win("2026-13-45")).toBeNull();
  });
});

/** A reader that records the query it got and serves canned rows. */
function fakeReader(rows: RecalledTurn[], earliest: Date | null, total = rows.length) {
  const queries: TurnQuery[] = [];
  const deps: RecallDeps = {
    clock: () => NOW,
    timeZone: TZ,
    reader: {
      async find(q) {
        queries.push(q);
        return { turns: rows.slice(0, q.limit), total };
      },
      async earliest() {
        return earliest;
      },
    },
  };
  return { deps, queries };
}

describe("recallConversation — the answer", () => {
  it("shows what the founder sent, in his own words, with the day and the range it searched", async () => {
    const { deps, queries } = fakeReader(
      [
        turn({ at: "2026-10-03T16:11:00Z", user_input: "can you check why the PR bot paused?", outcome: "done", reply: "The review bot paused because the model name was retired." }),
        turn({ at: "2026-10-03T08:00:00Z", user_input: "what's on today", reply: "Two PRs waiting." }),
      ],
      new Date("2026-10-01T00:00:00Z"),
    );
    const out = await recallConversation({ threadId: "turicks:1", when: "yesterday" }, deps);

    expect(queries[0]).toMatchObject({ threadId: "turicks:1", since: istMidnight("2026-10-03"), until: istMidnight("2026-10-04"), terms: [] });
    expect(out).toContain("yesterday (Sat 3 Oct)");
    expect(out).toContain('You: "can you check why the PR bot paused?"');
    expect(out).toContain("The review bot paused because the model name was retired.");
    expect(out).toContain("Yesterday, 9:41 PM"); // 16:11Z = 21:41 IST
  });

  it("lists a window oldest-first, like the day happened", async () => {
    const { deps } = fakeReader(
      [turn({ at: "2026-10-03T16:00:00Z", user_input: "second" }), turn({ at: "2026-10-03T08:00:00Z", user_input: "first" })],
      new Date("2026-10-01T00:00:00Z"),
    );
    const out = await recallConversation({ threadId: "t", when: "yesterday" }, deps);
    expect(out.indexOf('"first"')).toBeGreaterThan(-1);
    expect(out.indexOf('"first"')).toBeLessThan(out.indexOf('"second"'));
  });

  it("shows five at first and says how many more there are, instead of dumping the day", async () => {
    const rows = Array.from({ length: 14 }, (_, i) => turn({ at: `2026-10-03T${String(8 + (i % 10)).padStart(2, "0")}:${String(i).padStart(2, "0")}:00Z`, user_input: `msg ${i}` }));
    const { deps, queries } = fakeReader(rows, new Date("2026-10-01T00:00:00Z"), 14);
    const out = await recallConversation({ threadId: "t", when: "yesterday" }, deps);
    expect(queries[0]!.limit).toBe(5);
    expect((out.match(/You: "/g) ?? []).length).toBe(5);
    expect(out).toContain("latest 5 of 14");
    expect(out).toContain("9 more");
    expect(out).toContain("show more");
  });

  it("'what did I just ask you?' reads the last half hour and says so, instead of refusing to parse the time", async () => {
    const { deps, queries } = fakeReader([turn({ at: "2026-10-04T09:50:00Z", user_input: "what's running" })], new Date("2026-10-04T08:00:00Z"));
    const out = await recallConversation({ threadId: "t", when: "a minute ago" }, deps);
    expect(queries[0]).toMatchObject({ since: new Date("2026-10-04T09:30:00Z"), until: NOW });
    expect(out).toContain("the last 30 minutes");
    expect(out).toContain('You: "what\'s running"');
    expect(out).not.toContain("couldn't read the time");
  });

  it("'show more' raises the cap to 12", async () => {
    const { deps, queries } = fakeReader([turn({ at: "2026-10-03T08:00:00Z" })], new Date("2026-10-01T00:00:00Z"));
    await recallConversation({ threadId: "t", when: "yesterday", more: true }, deps);
    expect(queries[0]!.limit).toBe(12);
  });

  it("searches by topic words, drops filler, and says how many mentions it found", async () => {
    const { deps, queries } = fakeReader(
      [turn({ at: "2026-09-29T08:00:00Z", user_input: "any update on the visa paperwork?", reply: "Nothing new on the visa." })],
      new Date("2026-09-01T00:00:00Z"),
    );
    const out = await recallConversation({ threadId: "t", about: "what did I say about the visa" }, deps);
    expect(queries[0]!.terms).toEqual(["visa"]);
    expect(out).toContain('1 message mentioning "visa"');
    expect(out).toContain('You: "any update on the visa paperwork?"');
  });

  it("marks a failed turn honestly instead of showing its reply as a success", async () => {
    const { deps } = fakeReader(
      [turn({ at: "2026-10-03T08:00:00Z", user_input: "deploy it", outcome: "failed", reply: "Deploy blocked: CI was red." })],
      new Date("2026-10-01T00:00:00Z"),
    );
    const out = await recallConversation({ threadId: "t", when: "yesterday" }, deps);
    expect(out).toContain("that one failed");
    expect(out).toContain("Deploy blocked: CI was red.");
  });

  it("cuts long messages at a word boundary and collapses whitespace", async () => {
    const long = `${"word ".repeat(80)}\n\nend`;
    const { deps } = fakeReader([turn({ at: "2026-10-03T08:00:00Z", user_input: long, reply: long })], new Date("2026-10-01T00:00:00Z"));
    const out = await recallConversation({ threadId: "t", when: "yesterday" }, deps);
    const quoted = /You: "([^"]*)"/.exec(out)![1]!;
    expect(quoted.length).toBeLessThanOrEqual(165);
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted).not.toContain("\n");
  });
});

describe("recallConversation — when there is nothing to show", () => {
  it("names what it searched and how far back memory goes, instead of 'no memory found'", async () => {
    const { deps } = fakeReader([], new Date("2026-10-02T06:00:00Z"));
    const out = await recallConversation({ threadId: "t", when: "last week", about: "visa" }, deps);
    expect(out).toContain('nothing mentioning "visa"');
    expect(out).toContain("last week");
    expect(out).toContain("I only started keeping conversations on Fri 2 Oct 2026");
    expect(out).toContain("isn't a sign");
    expect(out).toMatch(/try|wider|different word/i);
  });

  it("omits the memory-start note when the searched range lies wholly after it", async () => {
    const { deps } = fakeReader([], new Date("2026-09-01T00:00:00Z"));
    const out = await recallConversation({ threadId: "t", when: "yesterday", about: "visa" }, deps);
    expect(out).not.toContain("only started keeping");
  });

  it("says plainly that nothing has been saved yet for a chat with no log", async () => {
    const { deps } = fakeReader([], null);
    const out = await recallConversation({ threadId: "t", about: "visa" }, deps);
    expect(out).toContain("haven't saved any conversations from this chat yet");
  });

  it("refuses a time phrase it cannot read, and lists what it does understand", async () => {
    const { deps, queries } = fakeReader([], new Date("2026-10-01T00:00:00Z"));
    const out = await recallConversation({ threadId: "t", when: "sometime in spring" }, deps);
    expect(queries).toHaveLength(0);
    expect(out).toContain('couldn\'t read the time "sometime in spring"');
    expect(out).toContain("yesterday");
    expect(out).toContain("2026-09-30");
  });

  it("refuses a topic of only filler words rather than returning everything as if it matched", async () => {
    const { deps, queries } = fakeReader([turn({ at: "2026-10-03T08:00:00Z" })], new Date("2026-10-01T00:00:00Z"));
    const out = await recallConversation({ threadId: "t", about: "what did we" }, deps);
    expect(queries).toHaveLength(0);
    expect(out).toContain("more specific word");
  });

  it("with no time and no topic, shows the most recent messages", async () => {
    const { deps, queries } = fakeReader([turn({ at: "2026-10-03T08:00:00Z", user_input: "last thing" })], new Date("2026-10-01T00:00:00Z"));
    const out = await recallConversation({ threadId: "t" }, deps);
    expect(queries[0]).toMatchObject({ terms: [], limit: 5 });
    expect(queries[0]!.since).toBeUndefined();
    expect(out).toContain('"last thing"');
  });
});

describe("recallConversation — privacy", () => {
  it("refuses to run without a chat id, so one chat can never read another's log", async () => {
    const { deps, queries } = fakeReader([turn({ at: "2026-10-03T08:00:00Z" })], new Date("2026-10-01T00:00:00Z"));
    const out = await recallConversation({ threadId: "", when: "yesterday" }, deps);
    expect(queries).toHaveLength(0);
    expect(out).toContain("can't tell which chat");
  });
});
