/**
 * The guards that are supposed to notice when the pipeline shrinks
 * ================================================================
 * Three defects from the 2026-09-08 QA pass, all of the same family: a check that
 * reads as protection and had stopped protecting anything.
 *
 *   QA-8  `MIN_EXPECTED_BOARDS` stayed at 1100 while the registry went to 3,223,
 *         so two thirds of the file could have failed to parse and the floor
 *         would still have passed. The constant's own comment states the rule it
 *         was breaking: "a floor that is not moved with the file stops being a
 *         floor".
 *   QA-9  `parseBoardRegistry` dropped malformed rows with a bare `continue` —
 *         no count, no log — in a pipeline where every other drop is counted on
 *         principle.
 *   QA-5  `review_screened`, the tool whose stated purpose is that "a gate that
 *         wrongly rejects is otherwise invisible", could filter 2 of 5 permit
 *         bases and printed the founder's salary criterion above another
 *         candidate's rows.
 */

import { describe, it, expect } from "vitest";
import {
  MIN_EXPECTED_BOARDS,
  describeSkips,
  parseBoardRegistry,
  parseBoardRegistryWithSkips,
} from "../../../src/tools/jobhunt/free-boards.js";
import { pipelineHealth } from "../../../src/tools/jobhunt/review.js";
import { KNOWN_PERMIT_BASES } from "../../../src/tools/jobhunt/permit-routes.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";

const HEADER = "name,ats,board_token,markets";

describe("the thin-registry floor tracks the file it guards", () => {
  it("is set high enough to catch a partial parse of today's registry", () => {
    // 3,223 rows on 2026-09-08. A floor below ~85% of that is not a floor: it
    // passes while a corpus import silently removes hundreds of boards.
    expect(MIN_EXPECTED_BOARDS).toBeGreaterThanOrEqual(2_500);
  });
});

describe("a dropped registry row is counted, never silent", () => {
  it("counts rows naming a platform with no adapter", () => {
    const csv = [HEADER, "Acme,greenhouse,acme,NL", "Typo,greenhosue,typo,NL"].join("\n");
    const { boards, skips } = parseBoardRegistryWithSkips(csv);
    expect(boards).toHaveLength(1);
    expect(skips.unknownPlatform).toBe(1);
  });

  it("counts rows with no board token", () => {
    const csv = [HEADER, "Acme,greenhouse,acme,NL", "Blank,greenhouse,,NL"].join("\n");
    const { skips } = parseBoardRegistryWithSkips(csv);
    expect(skips.blankToken).toBe(1);
  });

  it("counts a repeated (ats, token) rather than dropping it silently", () => {
    // Legitimate — the same company appears under two market files — but a count
    // that suddenly jumps is how a broken import announces itself.
    const csv = [HEADER, "Acme,greenhouse,acme,NL", "Acme BV,greenhouse,acme,UK"].join("\n");
    const { boards, skips } = parseBoardRegistryWithSkips(csv);
    expect(boards).toHaveLength(1);
    expect(skips.duplicate).toBe(1);
  });

  it("says nothing when nothing was dropped", () => {
    const csv = [HEADER, "Acme,greenhouse,acme,NL"].join("\n");
    expect(describeSkips(parseBoardRegistryWithSkips(csv).skips)).toBe("Every row parsed.");
  });

  it("names every reason it dropped something", () => {
    const csv = [HEADER, "A,greenhouse,a,NL", "B,nope,b,NL", "C,greenhouse,,NL"].join("\n");
    const note = describeSkips(parseBoardRegistryWithSkips(csv).skips);
    expect(note).toContain("platform with no adapter");
    expect(note).toContain("no board token");
  });

  it("keeps the old single-return shape for every existing caller", () => {
    const csv = [HEADER, "Acme,greenhouse,acme,NL"].join("\n");
    expect(parseBoardRegistry(csv)).toHaveLength(1);
  });
});

describe("review_screened can see the whole table", () => {
  it("accepts every permit basis the screener can record", () => {
    // Was `["hsm", "remote-contract"]` — 97 of 1,705 prod rows (5.7%). The list
    // is now derived from the union, so it cannot fall behind it again.
    expect(KNOWN_PERMIT_BASES).toContain("zoekjaar");
    expect(KNOWN_PERMIT_BASES).toContain("partner-permit");
    expect(KNOWN_PERMIT_BASES).toContain("india-local");
  });
});

describe("the pipeline health line describes the queue it sits above", () => {
  const NOW = new Date("2026-09-08T00:00:00Z");

  it("quotes the reduced criterion when reviewing an orientation-year candidate", () => {
    const notes = pipelineHealth(NOW, getProfile("wife-nl-finance")).join(" ");
    expect(notes).toContain("Tashi");
    expect(notes).toContain("3122");
    expect(notes).not.toContain("4357");
  });

  it("quotes the standard criterion when reviewing the founder's own", () => {
    const notes = pipelineHealth(NOW, getProfile("pushkar-nl-tech")).join(" ");
    expect(notes).toContain("4357");
    expect(notes).not.toContain("3122");
  });
});
