/**
 * The register loader is the gate's data supply. These tests pin the two ways it
 * can silently ruin the campaign: mis-parsing quoted names (114 register entries
 * contain commas inside quotes) and returning an empty index, which would mark
 * every company `not-sponsor` and reject the entire reachable market.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseCsvLine,
  parseSponsorCsv,
  getSponsorIndex,
  resetSponsorIndexCache,
  SPONSOR_REGISTER_PATH,
} from "../../../src/tools/jobhunt/sponsor-registry.js";
import { matchSponsor } from "../../../src/tools/jobhunt/sponsor-match.js";

beforeEach(() => {
  resetSponsorIndexCache();
});

describe("parseCsvLine", () => {
  test("splits a plain unquoted row", () => {
    expect(parseCsvLine("Adyen N.V.,34259528")).toEqual(["Adyen N.V.", "34259528"]);
  });

  test("keeps commas that live inside a quoted field", () => {
    // Arrange — the real shape of the 114 quoted register rows.
    const line = '"AirLife Netherlands Holdings, B.V.",90558014';

    // Act
    const fields = parseCsvLine(line);

    // Assert — a naive split would produce three fields and corrupt the name.
    expect(fields).toEqual(["AirLife Netherlands Holdings, B.V.", "90558014"]);
  });

  test("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsvLine('"The ""Big"" Co",123')).toEqual(['The "Big" Co', "123"]);
  });
});

describe("parseSponsorCsv", () => {
  test("drops the header row and returns names only", () => {
    const csv = "name,kvk\nAdyen N.V.,34259528\nBooking.com B.V.,31047344\n";
    expect(parseSponsorCsv(csv)).toEqual(["Adyen N.V.", "Booking.com B.V."]);
  });

  test("keeps the first row when the file has no header", () => {
    expect(parseSponsorCsv("Adyen N.V.,34259528\n")).toEqual(["Adyen N.V."]);
  });

  test("returns empty for an empty file rather than a bogus entry", () => {
    expect(parseSponsorCsv("")).toEqual([]);
    expect(parseSponsorCsv("\n\n")).toEqual([]);
  });
});

describe("getSponsorIndex", () => {
  test("loads the real register with every row indexed", () => {
    // Arrange — count the data rows on disk independently of the loader.
    const rawRows = readFileSync(SPONSOR_REGISTER_PATH, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0).length - 1;

    // Act
    const index = getSponsorIndex();

    // Assert — normalisation collapses a few duplicates, so allow shrinkage but
    // not the order-of-magnitude loss a parser bug would cause.
    expect(rawRows).toBeGreaterThan(12_000);
    expect(index.size).toBeGreaterThan(rawRows * 0.95);
  });

  test("caches the index across calls", () => {
    expect(getSponsorIndex()).toBe(getSponsorIndex());
  });

  test("a known recognised sponsor matches exactly", () => {
    const match = matchSponsor("Adyen N.V.", getSponsorIndex());
    expect(match.verdict).toBe("sponsor");
  });

  test("a company that is not on the register is rejected, not flagged", () => {
    const match = matchSponsor("Zzyzx Widgetworks", getSponsorIndex());
    expect(match.verdict).toBe("not-sponsor");
  });

  test("an unknown company sharing only a category word is rejected, not queued", () => {
    // Both were live failures against this register: "Analytics in HR B.V." and
    // "H.I. Systems" reduce to one category word each, so every company with
    // "Analytics" or "Systems" in its name inherited them as candidates and went
    // to the approval queue. The threshold that stops this is absolute (a token
    // in <=10 of ~12.9k entries), so it can only be pinned on the real register.
    expect(matchSponsor("Kwyjibo Analytics", getSponsorIndex()).verdict).toBe("not-sponsor");
    expect(matchSponsor("Fnordling Systems", getSponsorIndex()).verdict).toBe("not-sponsor");
  });

  test("a genuine abbreviation of a register entry still reaches a human", () => {
    // The cost asymmetry: quieting the queue must not turn real sponsors away.
    const match = matchSponsor("ASML", getSponsorIndex());
    expect(match.verdict).toBe("uncertain");
    expect(match.candidates.join(" ")).toContain("ASML");
  });
});
