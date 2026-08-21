/**
 * `/draft all`, `/draft 1,3,5`, and the packet message
 * ====================================================
 * The queue had 543 screened rows, 14 of them reachable, and two applications
 * lifetime. `/draft` handled exactly one row per invocation and ended with a PDF
 * and no next step. These are the two changes that close that: a command that
 * takes a list, and a message that says where the form is.
 *
 * Parsing is where an error is cheapest to catch and most expensive to miss — a
 * misparsed row number is a tailored application about the wrong company.
 */

import { describe, it, expect } from "vitest";
import { parseDraftArg, packetMessage } from "../../../src/gateway/jobhunt-commands.js";
import type { ApplicationPacket } from "../../../src/tools/jobhunt/apply-packet.js";
import type { JobApplication } from "../../../src/db/schema.js";

describe("parseDraftArg", () => {
  it("reads a single row", () => {
    expect(parseDraftArg("2")).toEqual({ rows: [2], all: false });
  });

  it("reads a comma list", () => {
    expect(parseDraftArg("1,3,5")).toEqual({ rows: [1, 3, 5], all: false });
  });

  it("reads a space-separated list", () => {
    expect(parseDraftArg("1 3 5")).toEqual({ rows: [1, 3, 5], all: false });
  });

  it("tolerates spaces around commas", () => {
    expect(parseDraftArg(" 1 , 3 ,5 ")).toEqual({ rows: [1, 3, 5], all: false });
  });

  it("de-duplicates without reordering", () => {
    expect(parseDraftArg("3,1,3")).toEqual({ rows: [3, 1], all: false });
  });

  it("recognises `all`, case-insensitively", () => {
    expect(parseDraftArg("all")).toEqual({ rows: [], all: true });
    expect(parseDraftArg("ALL")).toEqual({ rows: [], all: true });
  });

  // A partially valid list is a REFUSAL. "1,x,3" almost certainly means a row
  // the founder wants and mistyped; tailoring two of the three he asked for and
  // saying nothing about the third is the silent failure worth avoiding.
  it("refuses a list with any unparseable member rather than dropping it", () => {
    expect(parseDraftArg("1,x,3")).toBeNull();
    expect(parseDraftArg("1,two")).toBeNull();
    expect(parseDraftArg("1,-2")).toBeNull();
    expect(parseDraftArg("0")).toBeNull();
  });

  it("refuses empty input so the usage message fires", () => {
    expect(parseDraftArg("")).toBeNull();
    expect(parseDraftArg("   ")).toBeNull();
  });
});

const ROW = {
  id: "row-abcdef12",
  company: "Ockto",
  title: "Senior Site Reliability Engineer",
  route: "hsm",
  url: "https://ockto.recruitee.com/o/senior-site-reliability-engineer",
} as unknown as JobApplication;

function packet(overrides: Partial<ApplicationPacket> = {}): ApplicationPacket {
  return {
    row: ROW,
    pdfPath: "/artifacts/t/cv-ockto-row-abcd.pdf",
    cvMarkdown: "# PUSHKAR VERMA",
    matchedSkills: ["TypeScript", "PostgreSQL", "Docker"],
    missingSkills: ["Terraform"],
    applyUrl: "https://ockto.recruitee.com/o/senior-site-reliability-engineer/c/new",
    opensTheForm: true,
    ...overrides,
  };
}

describe("packetMessage", () => {
  it("carries the apply link, the overlap, and the close-out command", () => {
    const out = packetMessage(packet(), 2);
    expect(out).toContain("Ockto");
    expect(out).toContain("Senior Site Reliability Engineer");
    expect(out).toContain("/c/new");
    expect(out).toContain("Open the application form");
    // 3 matched of 4 asked — the one number that changes whether he reads the
    // packet before sending it or sends it first.
    expect(out).toContain("3/4");
    expect(out).toContain("/applied 2");
  });

  // A link the founder taps once, finds nothing, and stops trusting is worse
  // than an honest "this is the posting". Say which one it is.
  it("says so when the link is the posting rather than the form", () => {
    const out = packetMessage(
      packet({ opensTheForm: false, applyUrl: "https://jobs.smartrecruiters.com/x/1" }),
      1,
    );
    expect(out).toContain("Open the posting");
    expect(out).toContain("hides the form");
    expect(out).not.toContain("Open the application form");
  });

  it("never renders a bare empty link when no URL is on file", () => {
    const out = packetMessage(packet({ applyUrl: "", opensTheForm: false }), 1);
    expect(out).toContain("No URL on file");
    expect(out).not.toContain("href=\"\"");
  });

  // Real job titles carry "&" and "<" (prod: "Bloom & Wild Group"). Telegram
  // rejects the WHOLE message on an unparseable entity, so the packet must not
  // fail on the packet's own content.
  it("escapes HTML in company and title", () => {
    const out = packetMessage(
      packet({ row: { ...ROW, company: "Bloom & Wild", title: "Engineer <all levels>" } as JobApplication }),
      1,
    );
    expect(out).toContain("Bloom &amp; Wild");
    expect(out).toContain("&lt;all levels&gt;");
  });

  it("reports honestly when the posting listed no skills", () => {
    const out = packetMessage(packet({ matchedSkills: [], missingSkills: [] }), 1);
    expect(out).toContain("no skill list on the posting");
    expect(out).not.toContain("0/0");
  });
});
