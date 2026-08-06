/**
 * Unit tests — the stretch section, and the accounting the ASK section never had.
 *
 * On 2026-08-06 the Experience gate stopped rejecting 5-6 stated years and
 * started FLAGGING them, on the reasoning that "5+ years" is a wish rather than
 * a wall for a strong candidate at ~3.5 years. Nothing downstream was adjusted
 * to receive those flags, and the change made the rescued rows LESS visible than
 * the rejects they replaced:
 *
 *   · as a reject they appeared under TOO SENIOR, which prints the UNCAPPED
 *     total, names up to REJECT_CAP of them, and states the remainder.
 *   · as a flag they landed in ASK, which prints the POST-CAP count and appended
 *     no overflow note at all — so the fifth flagged role was printed nowhere and
 *     counted nowhere, under a header that says "Nothing is cut".
 *
 * The second half is worse. The only command ASK offers is `/ask`, which writes a
 * question to the employer about the unresolved check — i.e. it would ask whether
 * the five-year bar is firm, inviting a pre-emptive rejection on the one gate the
 * whole change argues is aspirational. A years flag is not a question for anyone;
 * it is an application to write. Hence a third section, carrying `/draft`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ASK_CAP,
  STRETCH_CAP,
  formatDailyBrief,
  selectAskable,
  selectStretch,
  type BriefInput,
  type BriefRow,
} from "../../../src/tools/jobhunt/brief.js";
import type { Gate } from "../../../src/tools/jobhunt/gates.js";

const CLEARED: readonly Gate[] = [
  { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
  { gate: "Salary", status: "pass", evidence: "Clears the €52,284 criterion." },
  { gate: "Language", status: "pass", evidence: "No Dutch requirement found." },
];

const YEARS_FLAG: Gate = {
  gate: "Experience",
  status: "flag",
  evidence:
    'Asks for 5 years minimum; you have ~3.5 shipped. Their words: "5+ years of ' +
    'experience required". The bar is above your years but within reach — apply ' +
    "if the stack matches, and apply early.",
};

const SALARY_FLAG: Gate = {
  gate: "Salary",
  status: "flag",
  evidence: "The ad states no salary, so the permit floor cannot be checked from it.",
};

function row(over: Partial<BriefRow> & Pick<BriefRow, "id">): BriefRow {
  return {
    company: `Company ${over.id}`,
    title: "Backend Engineer",
    track: "backend",
    verdict: "pass",
    route: "hsm",
    country: "NL",
    location: "Amsterdam, Netherlands",
    url: "https://example.com/1",
    overlap: { matched: ["TypeScript"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates: CLEARED,
    legacyGates: false,
    ageDays: 0,
    ...over,
  };
}

/** A row whose ONLY unresolved check is the years bar. */
function stretchRow(id: string, over: Partial<BriefRow> = {}): BriefRow {
  return row({ id, verdict: "flag", gates: [...CLEARED, YEARS_FLAG], ...over });
}

/** A row flagged on the years AND on something a question could actually settle. */
function mixedFlagRow(id: string): BriefRow {
  return row({
    id,
    verdict: "flag",
    gates: [
      CLEARED[0] as Gate,
      SALARY_FLAG,
      CLEARED[2] as Gate,
      YEARS_FLAG,
    ],
  });
}

function input(rows: readonly BriefRow[]): BriefInput {
  return {
    date: new Date("2026-08-06T06:00:00Z"),
    screened: rows.length,
    perTrack: { backend: rows.length },
    rows,
    trends: [],
    failures: [],
  };
}

describe("selectStretch — membership is decided by gate STATUS, never by prose", () => {
  it("takes a row whose only unresolved check is the years bar", () => {
    expect(selectStretch([stretchRow("a")]).map((r) => r.id)).toEqual(["a"]);
  });

  it("leaves a row flagged on the years AND something else in ASK", () => {
    // A missing salary IS a question for the employer. The years are not — asking
    // "is the 5 years firm?" invites the rejection this whole band exists to
    // avoid. A row carrying both is a genuine question, so it stays in ASK.
    const rows = [mixedFlagRow("mixed")];
    expect(selectStretch(rows)).toEqual([]);
    expect(selectAskable(rows).map((r) => r.id)).toEqual(["mixed"]);
  });

  it("keeps an Experience-only flag OUT of ASK", () => {
    // The regression this section exists to fix: `/ask` was the only command
    // attached to these rows, and it is the wrong action for every one of them.
    expect(selectAskable([stretchRow("a")])).toEqual([]);
  });

  it("never offers a posting that has already closed", () => {
    expect(selectStretch([stretchRow("gone", { liveness: "expired" })])).toEqual([]);
  });

  it("does not take a row that cleared every check — that is APPLY TODAY", () => {
    expect(selectStretch([row({ id: "clean" })])).toEqual([]);
  });

  it("does not take a rejected row", () => {
    const rejected = row({
      id: "senior",
      verdict: "reject",
      gates: [
        ...CLEARED,
        { gate: "Experience", status: "reject", evidence: "Asks for 10 years minimum." },
      ],
    });
    expect(selectStretch([rejected])).toEqual([]);
  });
});

describe("the stretch section is about applying, not asking", () => {
  it("renders between APPLY TODAY and ONE QUESTION AWAY", () => {
    const out = formatDailyBrief(
      input([row({ id: "ready" }), stretchRow("s1"), mixedFlagRow("q1")]),
    );
    expect(out.indexOf("APPLY TODAY")).toBeLessThan(out.indexOf("STRETCH"));
    expect(out.indexOf("STRETCH")).toBeLessThan(out.indexOf("ONE QUESTION AWAY"));
  });

  it("attaches /draft to a stretch row and never /ask", () => {
    const out = formatDailyBrief(input([stretchRow("s1"), mixedFlagRow("q1")]));
    const section = out.slice(out.indexOf("STRETCH"), out.indexOf("ONE QUESTION AWAY"));
    expect(section).toContain("/draft 1");
    expect(section).not.toContain("/ask");
  });

  it("says the bar is above his years and that applying early is the move", () => {
    const out = formatDailyBrief(input([stretchRow("s1")]));
    expect(out).toMatch(/STRETCH/);
    expect(out.toLowerCase()).toContain("apply");
  });

  it("numbers stretch rows continuing from DO TODAY, as one run", () => {
    // `/draft N` resolves against do_today THEN stretch on one continuous
    // numbering, so the printed number and the pinned rank must agree by
    // construction. Restarting at 1 would make `/draft 1` ambiguous.
    const out = formatDailyBrief(
      input([row({ id: "d1" }), row({ id: "d2" }), stretchRow("s1"), stretchRow("s2")]),
    );
    const section = out.slice(out.indexOf("STRETCH"), out.indexOf("DO THIS NEXT"));
    expect(section).toContain("/draft 3");
    expect(section).toContain("/draft 4");
    expect(section).not.toContain("/draft 1");
    expect(section).not.toContain("/draft 2");
  });

  it("lists every stretch row in DO THIS NEXT with its continued number", () => {
    const out = formatDailyBrief(input([row({ id: "d1" }), stretchRow("s1")]));
    const next = out.slice(out.indexOf("DO THIS NEXT"));
    expect(next).toContain("/draft 1");
    expect(next).toContain("/draft 2");
  });

  it("does not read 'nothing actionable' when only stretch rows are standing", () => {
    // A header that denies the rows printed below it is the same class of defect
    // as hiding them.
    const out = formatDailyBrief(input([stretchRow("s1")]));
    expect(out).not.toContain("Nothing actionable today");
  });
});

describe("both flag sections count what they cut", () => {
  it("puts the UNCAPPED total in the stretch heading and names the remainder", () => {
    const rows = Array.from({ length: STRETCH_CAP + 2 }, (_, i) => stretchRow(`s${i}`));
    const out = formatDailyBrief(input(rows));
    expect(out).toContain(`STRETCH WORTH APPLYING TO (${STRETCH_CAP + 2})`);
    expect(out).toContain("+ 2 more");
  });

  it("puts the UNCAPPED total in the ASK heading and names the remainder", () => {
    // The Finding-1 regression, verbatim: the heading printed the POST-CAP count
    // and appended no overflow note, under a header promising "Nothing is cut".
    const rows = Array.from({ length: ASK_CAP + 3 }, (_, i) => mixedFlagRow(`q${i}`));
    const out = formatDailyBrief(input(rows));
    expect(out).toContain(`ONE QUESTION AWAY (${ASK_CAP + 3})`);
    expect(out).toContain("+ 3 more");
  });

  it("counts the population in the top line too, not the capped slice", () => {
    // One rule for every number in the message: a count is the true population,
    // and the cap only ever shows up as "+ N more not shown". A top line that
    // counted the slice while the section counted the population would read as
    // two contradictory claims about the same day.
    const rows = Array.from({ length: STRETCH_CAP + 2 }, (_, i) => stretchRow(`s${i}`));
    const header = formatDailyBrief(input(rows)).split("\n")[1] ?? "";
    expect(header).toContain(`${STRETCH_CAP + 2} worth a stretch`);
  });

  it("adds no overflow note when nothing was cut", () => {
    const out = formatDailyBrief(input([stretchRow("s1"), mixedFlagRow("q1")]));
    expect(out).toContain("STRETCH WORTH APPLYING TO (1)");
    expect(out).toContain("ONE QUESTION AWAY (1)");
    expect(out).not.toContain("not shown here");
  });

  it("renders deterministically", () => {
    const rows = [row({ id: "d1" }), stretchRow("s1"), mixedFlagRow("q1")];
    expect(formatDailyBrief(input(rows))).toBe(formatDailyBrief(input(rows)));
  });
});

describe("what gets pinned is what gets printed", () => {
  beforeEach(() => vi.resetModules());

  it("stores the stretch ranks at the numbers the message shows", async () => {
    // The failure this guards is silent and expensive: the renderer offsets the
    // stretch block by DO TODAY's length, and `persistBriefRanks` must offset it
    // by the same amount. Two places computing the same offset independently
    // drift the day one of them changes — and the symptom is a polished
    // application written about a company the founder never chose.
    type RankEntry = { id: string; section: string; rank: number };
    const recordBriefRanks = vi.fn(async (_entries: readonly RankEntry[]) => undefined);
    vi.doMock("../../../src/db/job-queries.js", () => ({
      recordBriefRanks,
      recordFitScores: vi.fn(async () => undefined),
    }));
    const { persistBriefRanks } = await import("../../../src/tools/jobhunt/brief-persist.js");

    const rows = [row({ id: "d1" }), row({ id: "d2" }), stretchRow("s1"), mixedFlagRow("q1")];
    await persistBriefRanks(rows);

    expect(recordBriefRanks).toHaveBeenCalledOnce();
    expect(recordBriefRanks.mock.calls[0]![0]).toEqual([
      { id: "d1", section: "do_today", rank: 1 },
      { id: "d2", section: "do_today", rank: 2 },
      { id: "s1", section: "stretch", rank: 3 },
      { id: "q1", section: "ask", rank: 1 },
    ]);

    // …and the message prints those same numbers.
    const out = formatDailyBrief(input(rows));
    expect(out.slice(out.indexOf("STRETCH"), out.indexOf("ONE QUESTION AWAY"))).toContain(
      "/draft 3",
    );
  });
});
