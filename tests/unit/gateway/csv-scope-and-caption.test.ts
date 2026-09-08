/**
 * Unit tests — `/csv` reaches the same slices the screen verbs do, and says
 * which links it actually checked.
 *
 * TWO FAILURES THIS GUARDS AGAINST, both measured 2026-09-09.
 *
 * 1. `/csv` knew two words, "queue" and "all", while `/jobs`, `/today` and
 *    `/fresh` had a full resolver behind them. So the founder could ask for
 *    today's roles on screen and not in a file — backwards, because the file is
 *    what he wants precisely when the screen cannot hold the answer.
 *
 * 2. The caption named a row count and nothing about verification. A file that
 *    checked 150 of 1,700 links and said only "150 verified" reads as complete,
 *    which is the silent-truncation defect one layer down.
 */

import { describe, it, expect } from "vitest";
import {
  csvCaption,
  csvFilename,
  describeVerification,
  parseCsvKind,
  parseCsvVerb,
} from "../../../src/gateway/jobhunt-view.js";

describe("parseCsvVerb", () => {
  it("recognises today", () => {
    expect(parseCsvVerb("today")).toBe("today");
  });

  it("recognises fresh, and 'new' as the word people actually type", () => {
    expect(parseCsvVerb("fresh")).toBe("fresh");
    expect(parseCsvVerb("new")).toBe("fresh");
  });

  it("reads the verb from the first word, so a range can follow it", () => {
    expect(parseCsvVerb("today 2d")).toBe("today");
  });

  it("is null for the old vocabulary, which must keep working", () => {
    expect(parseCsvVerb("all")).toBeNull();
    expect(parseCsvVerb("queue")).toBeNull();
    expect(parseCsvVerb("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(parseCsvVerb("TODAY")).toBe("today");
  });
});

describe("parseCsvKind", () => {
  it("still defaults to the queue, unchanged", () => {
    expect(parseCsvKind("")).toBe("queue");
    expect(parseCsvKind("all")).toBe("log");
  });
});

describe("describeVerification", () => {
  it("names the unchecked rows rather than implying a complete file", () => {
    const line = describeVerification({ verified: 150, skipped: 1550, alreadyFresh: 0 });
    expect(line).toContain("150");
    expect(line).toContain("1550");
    expect(line).toMatch(/budget|last known/i);
  });

  it("counts rows already checked recently as confirmed, not as unchecked", () => {
    // Re-checking a link confirmed an hour ago spends budget an unchecked row
    // needs more. It is still a confirmed link.
    const line = describeVerification({ verified: 10, skipped: 0, alreadyFresh: 40 });
    expect(line).toContain("50");
  });

  it("says nothing about a budget when nothing was cut", () => {
    const line = describeVerification({ verified: 12, skipped: 0, alreadyFresh: 0 });
    expect(line).not.toMatch(/budget/i);
  });
});

describe("csvCaption", () => {
  it("appends the verification line when one is given", () => {
    const caption = csvCaption("queue", 20, { verified: 20, skipped: 0, alreadyFresh: 0 });
    expect(caption).toContain("20 roles in your apply queue");
    expect(caption).toContain("confirmed against the employer's site");
  });

  it("omits the verification line when the check was skipped", () => {
    const caption = csvCaption("queue", 20);
    expect(caption).not.toContain("confirmed against");
  });

  it("counts in singular when there is one row", () => {
    expect(csvCaption("queue", 1)).toContain("1 role in your apply queue");
  });

  it("explains an empty file rather than sending a bare zero", () => {
    expect(csvCaption("queue", 0)).toMatch(/empty/i);
  });
});

describe("csvFilename", () => {
  it("is dated, so two downloads never collide", () => {
    expect(csvFilename("log", new Date("2026-09-09T12:00:00Z"))).toBe("jobs-log-2026-09-09.csv");
  });
});
