import { describe, expect, it } from "vitest";
import {
  A_LOG_MAX_AGE_H,
  istDayWindow,
  parseJourneyALog,
  REMINDER_FIRE_LIMIT_MS,
  saysNothing,
  scoreCalendar,
  scoreInbox,
  scorePrs,
  scoreReminder,
} from "../../../scripts/lib/journey-score.js";

const NOW = Date.parse("2026-10-09T02:30:00Z");

describe("saysNothing", () => {
  it("reads an empty answer as empty", () => {
    expect(saysNothing("Nothing important in your work inbox since yesterday.")).toBe(true);
    expect(saysNothing("Your calendar is clear today, no events.")).toBe(true);
  });
  it("does not read a list as empty", () => {
    expect(saysNothing("3 emails: Invoice 42, Standup notes, Offer letter")).toBe(false);
  });
});

describe("scoreInbox (J1)", () => {
  const subjects = ["Re: Q4 invoice from Acme", "Standup notes 08 Oct"];
  it("passes when the reply names one real subject", () => {
    const v = scoreInbox("Two things: the Q4 invoice from Acme needs a reply, and a newsletter.", subjects);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("Q4 invoice from Acme");
  });
  it("fails when the reply names none of the real subjects and lists them", () => {
    const v = scoreInbox("You have a message about a dentist appointment.", subjects);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Standup notes 08 Oct");
  });
  it("passes on 'nothing' when gws found nothing", () => {
    expect(scoreInbox("Nothing new in your work inbox since yesterday.", []).ok).toBe(true);
  });
  it("fails when gws found nothing but the bot invents mail", () => {
    expect(scoreInbox("You got an email from Priya about the launch.", []).ok).toBe(false);
  });

  // 2026-10-09 run 47393614: the bot read the MoM mail correctly but shortened the subject.
  const mom = [{ subject: "MoM | 8 Oct 2026", sender: "Sandeep Bist <sandeep@example.com>" }];
  const momReply = "One email found in the work inbox since yesterday — MoM from Sandeep Bist dated Oct 8, 2026.";
  it("passes when the reply names the sender instead of the exact subject", () => {
    const v = scoreInbox("One email since yesterday, from Sandeep Bist, about next steps on AWS cost.", mom);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("sender");
  });
  it("passes when the reply names the subject's keyword and not its date punctuation", () => {
    const v = scoreInbox(momReply.replace("Sandeep Bist", "your manager"), mom);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("keywords");
  });
  it("passes the 2026-10-09 reply as a whole", () => {
    expect(scoreInbox(momReply, mom).ok).toBe(true);
  });
  it("does not match a sender by a bare email domain or a one-word generic keyword like 'update'", () => {
    const generic = [{ subject: "Weekly update", sender: "no-reply@example.com" }];
    expect(scoreInbox("There was an update on the project.", generic).ok).toBe(false);
  });
  it("still fails when nothing about the real mail appears", () => {
    expect(scoreInbox("You have a message about a dentist appointment.", mom).ok).toBe(false);
  });
});

describe("scoreCalendar (J2)", () => {
  const events = ["Dentist", "Oplify sync"];
  it("passes when every event is named", () => {
    expect(scoreCalendar("Today: 10:00 Dentist, 15:00 Oplify sync.", events).ok).toBe(true);
  });
  it("fails and names the missing event", () => {
    const v = scoreCalendar("Today you have the dentist at 10.", events);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Oplify sync");
  });
  it("passes on an empty day when gws has no events", () => {
    expect(scoreCalendar("Your calendar is empty today.", []).ok).toBe(true);
  });
  it("fails when gws has no events but the bot lists one", () => {
    expect(scoreCalendar("You have a 1:1 with Sam at 11.", []).ok).toBe(false);
  });
});

describe("scorePrs (J3)", () => {
  const prs = [
    { number: 1036, ci: "green", createdAt: "2026-10-08T10:00:00Z" },
    { number: 1002, ci: "red", createdAt: "2026-10-05T10:00:00Z" },
  ];
  const good = "Open PRs on FounderOS:\n• #1036 daily journeys: CI green\n• #1002 probe fix: CI failing (lint)";
  it("passes when every number and verdict matches and the follow-up names the oldest", () => {
    expect(scorePrs(good, "The oldest is #1002; lint is failing.", prs).ok).toBe(true);
  });
  it("fails when a PR is missing", () => {
    const v = scorePrs("• #1036 CI green", "#1002 is oldest", prs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("#1002 not named");
  });
  it("fails when a CI verdict is wrong", () => {
    const v = scorePrs("• #1036 CI green\n• #1002 CI green", "#1002", prs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("#1002: GitHub says red");
  });
  it("fails when the follow-up names the wrong PR", () => {
    const v = scorePrs(good, "The oldest is #1036.", prs);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("follow-up did not name the oldest PR #1002");
  });
  it("does not read 'required' as a red verdict", () => {
    expect(scorePrs("• #1036 CI green\n• #1002 required checks", "#1002", prs).ok).toBe(false);
  });
  it("reads a markdown table row with a bare PR number (2026-10-08: `| 1018 |` was missed)", () => {
    const table = "| # | Title | CI |\n|---|---|---|\n| 1036 | daily journeys | Green |\n| 1002 | probe fix | Failing (lint) |";
    expect(scorePrs(table, "The oldest is **#1002**.", prs).ok).toBe(true);
  });
  it("does not read a bare number inside another number or a date as a PR", () => {
    expect(scorePrs("Updated 2026-10-02 ...\n10360 rows | Green", "", prs).ok).toBe(false);
    expect(scorePrs("| 11036 | green |\n| 1002 | red |", "#1002", prs).detail).toContain("#1036 not named");
  });
  it("passes when there are no open PRs and the bot says so", () => {
    expect(scorePrs("There are no open PRs on FounderOS.", "", []).ok).toBe(true);
  });

  // 2026-10-09 run 47393614: the reply grouped PRs under "CI Red" / "CI Pending" headings, so no PR line carried a colour.
  const grouped =
    "13 open PRs total.\n\n**CI Pending (1):**\n- #1053 spec fix\n\n**CI Red (2) — failing check \"PR scope\":**\n- #1048 journeys (draft)\n- #1010 plans (draft)\n\n**CI Green (1):** #1051";
  const gprs = [
    { number: 1053, ci: "pending", createdAt: "2026-10-08T10:00:00Z" },
    { number: 1048, ci: "red", createdAt: "2026-10-07T10:00:00Z" },
    { number: 1010, ci: "red", createdAt: "2026-10-05T10:00:00Z" },
    { number: 1051, ci: "green", createdAt: "2026-10-08T12:00:00Z" },
  ];
  it("takes the colour from the heading above the PR line when the line has none", () => {
    expect(scorePrs(grouped, "#1010 is the oldest.", gprs).ok).toBe(true);
  });
  it("still fails a PR listed under the wrong heading", () => {
    const wrong = scorePrs("**CI Red (1):**\n- #1048 journeys", "#1048", [{ number: 1048, ci: "green", createdAt: "2026-10-07T10:00:00Z" }]);
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toContain("#1048: GitHub says green");
  });
  it("does not trust a summary heading that names several colours", () => {
    const summary = "9 green, 3 red, 2 pending\n- #1036 daily journeys\n- #1002 probe fix";
    expect(scorePrs(summary, "#1002", prs).ok).toBe(false);
  });
  it("tolerates a PR that was closed after the snapshot", () => {
    const v = scorePrs("• #1036 CI green", "#1036", prs, new Set([1036]));
    expect(v.ok).toBe(true);
  });
  it("tolerates a PR opened after the snapshot (extra PRs in the reply are not an error)", () => {
    expect(scorePrs(`${good}\n• #1060 new thing: CI pending`, "#1002", prs).ok).toBe(true);
  });
  it("accepts any colour for a snapshot PR whose CI was still pending", () => {
    const pending = [{ number: 1053, ci: "pending", createdAt: "2026-10-08T10:00:00Z" }];
    expect(scorePrs("• #1053 CI green", "#1053", pending).ok).toBe(true);
  });
  it("names the oldest PR among those still open", () => {
    expect(scorePrs("• #1036 CI green", "#1036 is oldest", prs, new Set([1036])).ok).toBe(true);
  });
});

describe("scoreReminder (J5)", () => {
  const askedAt = "2026-10-09T02:31:00Z";
  const created = { text: "check the journeys", firedAt: "2026-10-09T02:33:05Z" };
  const list = "You have 2 reminders: check the journeys (02:33 UTC) and call the bank (Friday).";
  const scheduled = ["check the journeys", "Call the bank"];
  it("passes when it fired within the limit and the list matches the table", () => {
    expect(scoreReminder({ askedAt, created, listReply: list, scheduled }).ok).toBe(true);
  });
  it("fails when no reminder row was created", () => {
    const v = scoreReminder({ askedAt, created: undefined, listReply: list, scheduled });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("no reminder row");
  });
  it("fails when it fired late", () => {
    const late = new Date(Date.parse(askedAt) + REMINDER_FIRE_LIMIT_MS + 60_000).toISOString();
    const v = scoreReminder({ askedAt, created: { ...created, firedAt: late }, listReply: list, scheduled });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("fired after");
  });
  it("fails when it never fired", () => {
    expect(scoreReminder({ askedAt, created: { ...created, firedAt: null }, listReply: list, scheduled }).ok).toBe(false);
  });
  it("fails when the list leaves out a scheduled reminder", () => {
    const v = scoreReminder({ askedAt, created, listReply: "You have one reminder: check the journeys.", scheduled });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("Call the bank");
  });
});

describe("parseJourneyALog", () => {
  const log =
    "GREEN journey A (o/r): PR a opened in 2 min with green CI\n" +
    "RED journey A (o/r): no PR in 45 min\n" +
    "GREEN journey A (o/r): PR task/issue-3 opened in 3 min with green CI\n";
  it("takes the last result line", () => {
    const r = parseJourneyALog(log, NOW - 3_600_000, NOW);
    expect(r.status).toBe("green");
    expect(r.detail).toContain("opened in 3 min");
  });
  it("is red when the last line is red", () => {
    expect(parseJourneyALog("GREEN journey A (o/r): ok\nRED journey A: no PR in 45 min\n", NOW, NOW).status).toBe("red");
  });
  it("is red when the log is stale", () => {
    const r = parseJourneyALog(log, NOW - (A_LOG_MAX_AGE_H + 1) * 3_600_000, NOW);
    expect(r.status).toBe("red");
    expect(r.detail).toContain("old");
  });
  it("is red when there is no log", () => {
    expect(parseJourneyALog(undefined, undefined, NOW).status).toBe("red");
  });
});

describe("istDayWindow", () => {
  it("returns an IST day as UTC instants", () => {
    // 08:00 IST on 10-09: yesterday is 10-08 00:00 IST (10-07 18:30Z) to 10-09 00:00 IST (10-08 18:30Z).
    expect(istDayWindow(NOW, -1)).toEqual({ start: "2026-10-07T18:30:00.000Z", end: "2026-10-08T18:30:00.000Z" });
    expect(istDayWindow(NOW, 0)).toEqual({ start: "2026-10-08T18:30:00.000Z", end: "2026-10-09T18:30:00.000Z" });
  });
});
