/**
 * Unit tests — B1: one parser behind the slash commands and the English.
 *
 * THE PROPERTY. `/jobs wife 2d` and "show me tashi's jobs from the last 2 days"
 * must produce the same rows, because if they do not, one of them is lying and
 * the founder has no way to tell which. The only way to guarantee that is for
 * both to reduce to the same argument object before anything reads the database,
 * which is what `parseBriefRequest` is.
 *
 * TWO AXES, KEPT APART. `posted` is when the employer published; `found` is when
 * we first stored it. Conflating them is defect T-1 of the truth audit and it is
 * the whole reason A1 exists. The founder's own phrasing carries the
 * distinction — "tashi's last 2 days jobs FOUNDED" is a question about our
 * discovery, not about the market — so the parser has to hear it.
 */

import { describe, it, expect } from "vitest";
import {
  parseBriefRequest,
  parseWindowHours,
  parseAxis,
  isProfileMiss,
  TODAY_WINDOW_HOURS,
} from "../../../src/tools/jobhunt/brief-resolver.js";

function ok(raw: string, verb: "jobs" | "today" | "fresh" = "jobs") {
  const result = parseBriefRequest(raw, verb);
  if (isProfileMiss(result)) throw new Error(`unexpected profile miss: ${result.unknown}`);
  return result;
}

describe("B1 — window parsing accepts what a person types on a phone", () => {
  it.each([
    ["2d", 48],
    ["2 days", 48],
    ["3d", 72],
    ["48h", 48],
    ["24 hours", 24],
    ["1 week", 168],
    ["this week", 168],
    ["week", 168],
    ["today", 24],
    ["1d", 24],
  ])("reads %j as %i hours", (text, hours) => {
    expect(parseWindowHours(text)).toBe(hours);
  });

  it("ignores the filler words a sentence carries", () => {
    expect(parseWindowHours("last 2 days")).toBe(48);
    expect(parseWindowHours("in the past 3 days")).toBe(72);
  });

  it("returns null rather than guessing at something it does not understand", () => {
    // A misread window silently changes which roles the founder sees. Null lets
    // the caller fall back to the verb's own default, which is stated on screen.
    expect(parseWindowHours("recently")).toBeNull();
    expect(parseWindowHours("")).toBeNull();
    expect(parseWindowHours("wife")).toBeNull();
  });
});

describe("B1 — the axis is read from the founder's own word", () => {
  it("hears discovery language as the found axis", () => {
    expect(parseAxis("founded")).toBe("found");
    expect(parseAxis("found")).toBe("found");
    expect(parseAxis("discovered")).toBe("found");
  });

  it("hears publication language as the posted axis", () => {
    expect(parseAxis("posted")).toBe("posted");
    expect(parseAxis("published")).toBe("posted");
  });

  it("returns null when neither was said, so the verb decides", () => {
    expect(parseAxis("2 days")).toBeNull();
    expect(parseAxis("")).toBeNull();
  });
});

describe("B1 — slash arguments", () => {
  it("/jobs — the founder's own queue, no age limit", () => {
    const req = ok("", "jobs");
    expect(req.profileId).toBe("pushkar-nl-tech");
    expect(req.explicitProfile).toBe(false);
    expect(req.windowHours).toBeNull();
    expect(req.axis).toBe("posted");
  });

  it("/jobs wife 2d — profile and range together", () => {
    const req = ok("wife 2d", "jobs");
    expect(req.profileId).toBe("wife-nl-finance");
    expect(req.explicitProfile).toBe(true);
    expect(req.windowHours).toBe(48);
    expect(req.axis).toBe("posted");
  });

  it("/jobs 3d — a range with no profile still resolves to the default", () => {
    const req = ok("3d", "jobs");
    expect(req.profileId).toBe("pushkar-nl-tech");
    expect(req.windowHours).toBe(72);
  });

  it("/today — a fixed 24h window that a range cannot override", () => {
    // That window IS the verb. `/today 1 week` is a contradiction, and honouring
    // the range would give the founder a list whose own heading denies it.
    expect(ok("", "today").windowHours).toBe(TODAY_WINDOW_HOURS);
    expect(ok("1 week", "today").windowHours).toBe(TODAY_WINDOW_HOURS);
    expect(ok("wife", "today").profileId).toBe("wife-nl-finance");
  });

  it("/fresh — the found axis, and no window (it is a delta, not a range)", () => {
    const req = ok("", "fresh");
    expect(req.axis).toBe("found");
    expect(req.windowHours).toBeNull();
  });

  it("/fresh wife — the delta for the other candidate", () => {
    expect(ok("wife", "fresh").profileId).toBe("wife-nl-finance");
  });

  it("refuses an unrecognised profile word instead of guessing", () => {
    // `/jobs wfie` is one keystroke from the wrong person's queue.
    const result = parseBriefRequest("wfie 2d", "jobs");
    expect(isProfileMiss(result)).toBe(true);
    if (isProfileMiss(result)) expect(result.unknown).toBe("wfie");
  });
});

describe("B1 — natural language reduces to the identical object", () => {
  it("'tashi's jobs' matches /jobs wife", () => {
    const nl = ok("tashi's jobs", "jobs");
    const slash = ok("wife", "jobs");
    expect(nl.profileId).toBe(slash.profileId);
    expect(nl.axis).toBe(slash.axis);
    expect(nl.windowHours).toBe(slash.windowHours);
  });

  it("'tashi's last 2 days jobs founded' carries range AND axis", () => {
    const req = ok("tashi's last 2 days jobs founded", "jobs");
    expect(req.profileId).toBe("wife-nl-finance");
    expect(req.windowHours).toBe(48);
    expect(req.axis).toBe("found");
  });

  it("'show me my fresh' is the founder's own delta", () => {
    const req = ok("show me my fresh", "fresh");
    expect(req.profileId).toBe("pushkar-nl-tech");
    expect(req.axis).toBe("found");
  });

  it("an explicit axis overrides the verb's default in both directions", () => {
    expect(ok("wife posted 2d", "fresh").axis).toBe("posted");
    expect(ok("wife found 2d", "jobs").axis).toBe("found");
  });

  it("does not read a stray sentence word as a profile miss", () => {
    // "the" is not a candidate and "show me my jobs" is not a typo — refusing
    // here would make the English surface unusable to protect against a mistake
    // it cannot make.
    expect(isProfileMiss(parseBriefRequest("show me the jobs", "jobs"))).toBe(false);
  });
});
