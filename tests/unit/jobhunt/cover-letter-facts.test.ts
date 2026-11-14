/**
 * The cover letter fact check. Two fixtures are the real sentences from prod,
 * 2026-11-14 (/apply on a Bengaluru role); names and numbers elsewhere are invented.
 */
import { describe, expect, it } from "vitest";
import {
  checkLetterFacts,
  readsWhole,
  removeSentences,
  type LetterFactContext,
} from "../../../src/tools/jobhunt/cover-letter-facts.js";

const SOURCE = [
  "Built an agent runtime that runs 623 boards and 31,000 postings a sweep. 3,712 tests.",
  "I am relocating to the Netherlands. Worked for myself since February 2026.",
].join("\n");

const NOW = new Date("2026-11-14T10:00:00Z");
const ctx = (over: Partial<LetterFactContext> = {}): LetterFactContext => ({
  postingCountry: "NL",
  sourceText: SOURCE,
  now: NOW,
  ...over,
});
const rules = (letter: string, c: LetterFactContext = ctx()): string[] => checkLetterFacts(letter, c).map((v) => v.rule);

describe("relocation and location claims", () => {
  it("flags the real Bosch sentence on an India posting (both start and relocation)", () => {
    const sentence = "I can start immediately and am relocating to the Netherlands.";
    const found = rules(sentence, ctx({ postingCountry: "IN", notice: { days: 0 } }));
    expect(found).toContain("relocation");
  });

  it("allows relocation to the posting country when the profile says so", () => {
    expect(rules("I am relocating to the Netherlands.")).toEqual([]);
  });

  it("flags relocation when nothing in the profile supports it", () => {
    expect(rules("I am relocating to the Netherlands.", ctx({ sourceText: "Built things." }))).toEqual(["relocation"]);
  });

  it("flags relocation when the posting country is unknown or other", () => {
    expect(rules("I am relocating to the Netherlands.", ctx({ postingCountry: "unknown" }))).toEqual(["relocation"]);
    expect(rules("I am relocating to the Netherlands.", ctx({ postingCountry: "other" }))).toEqual(["relocation"]);
  });

  it("flags a based-in claim for a country other than the posting's", () => {
    expect(rules("I am based in India.", ctx({ sourceText: "I am based in India." }))).toEqual(["relocation"]);
  });
});

describe("start and availability claims", () => {
  it("flags any start claim when no notice period is stored", () => {
    expect(rules("I can start immediately.")).toEqual(["availability"]);
    expect(rules("I am available from September.")).toEqual(["availability"]);
  });

  it("allows an immediate start only when the notice period is zero or described as immediate", () => {
    expect(rules("I can start immediately.", ctx({ notice: { days: 0 } }))).toEqual([]);
    expect(rules("I can start immediately.", ctx({ notice: { detail: "Immediately" } }))).toEqual([]);
    expect(rules("I can start immediately.", ctx({ notice: { days: 60 } }))).toEqual(["availability"]);
  });

  it("checks a dated start against the stored detail", () => {
    const notice = { detail: "Available from September" };
    expect(rules("I am available from September.", ctx({ notice }))).toEqual([]);
    expect(rules("I am available from January.", ctx({ notice }))).toEqual(["availability"]);
  });
});

describe("numbers and durations", () => {
  it("flags a test count that is not in the CV", () => {
    const found = checkLetterFacts("The suite has 3,666 tests.", ctx());
    expect(found.map((v) => v.rule)).toEqual(["number"]);
    expect(found[0]?.detail).toContain("3,666");
  });

  it("accepts numbers that appear in the CV, with or without separators", () => {
    expect(rules("It screens 31,000 postings across 623 boards.")).toEqual([]);
    expect(rules("It screens 31000 postings.")).toEqual([]);
  });

  it("does not treat years or the company name digits as claims", () => {
    expect(rules("I would like to join Web3 Labs in 2027.", ctx({ exemptText: "Web3 Labs" }))).toEqual([]);
  });

  it("flags the real 'over a year' sentence as an unsupported duration", () => {
    const letter = "I wrote the system in June 2026.\n\nI operated one for over a year.";
    const found = checkLetterFacts(letter, ctx());
    expect(found.some((v) => v.rule === "duration" && v.sentence.includes("over a year"))).toBe(true);
  });

  it("flags a duration the CV supports when the letter's own dates contradict it", () => {
    const letter = "I wrote the system in June 2026.\n\nI operated one for over a year.";
    const found = checkLetterFacts(letter, ctx({ sourceText: `${SOURCE}\nRan it for over a year.` }));
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("June 2026");
  });

  it("allows a supported duration with no contradicting date", () => {
    expect(rules("I operated one for over a year.", ctx({ sourceText: `${SOURCE}\nRan it for over a year.` }))).toEqual([]);
  });
});

describe("permit, visa and sponsorship claims", () => {
  it.each([
    "I hold a Dutch partner permit with full work rights.",
    "I do not need visa sponsorship.",
    "I have the right to work in the Netherlands.",
  ])("always flags: %s", (sentence) => {
    expect(rules(sentence, ctx({ sourceText: `${SOURCE}\n${sentence}` }))).toContain("permit");
  });
});

describe("removing sentences", () => {
  const LETTER = [
    "Dear Hiring Team,",
    "",
    "I read the posting and the platform work is what I do. I can start immediately.",
    "",
    "I built an agent runtime that screens 31,000 postings a sweep across 623 boards, and I kept it running on one server for months with jittered retries and a nightly health check.",
    "",
    "I would like to talk about how that maps to your reliability work, and I can share the repository and the run logs with the team before a call if that helps. I also kept notes on every outage, what broke, what I changed and what the numbers did afterwards, and I am glad to walk through them one by one with whoever owns reliability on your side.",
    "",
    "Pushkar",
  ].join("\n");

  it("drops only the offending sentence and keeps the paragraph", () => {
    const found = checkLetterFacts(LETTER, ctx());
    const out = removeSentences(LETTER, found.map((v) => v.sentence));
    expect(out).not.toContain("start immediately");
    expect(out).toContain("platform work is what I do.");
    expect(readsWhole(out)).toBe(true);
  });

  it("drops a paragraph that empties out and reports a short letter as not whole", () => {
    const out = removeSentences("Dear Hiring Team,\n\nOnly this.\n\nPushkar", ["Only this."]);
    expect(out).toBe("Dear Hiring Team,\n\nPushkar");
    expect(readsWhole(out)).toBe(false);
  });
});
