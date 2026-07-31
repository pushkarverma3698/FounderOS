/**
 * Unit tests — posting fact extraction.
 *
 * This module replaced LLM-supplied numbers inside a legal gate, so its edge
 * cases ARE the correctness of the pipeline. The governing rule under test:
 * when a value cannot be read confidently, emit nothing rather than a guess — a
 * wrong number produces a confident wrong verdict, an absent one produces a flag.
 */

import { describe, it, expect } from "vitest";
import {
  parseAmount,
  extractSalary,
  extractLanguage,
  extractRoute,
  extractFteFactor,
} from "../../../src/tools/jobhunt/extract.js";

describe("parseAmount", () => {
  it("reads a Dutch thousands separator as thousands, not a decimal point", () => {
    // The bug that would have rejected the entire Dutch market as sub-floor.
    expect(parseAmount("€4.500")).toBe(4500);
    expect(parseAmount("55.000")).toBe(55000);
  });

  it("reads an English thousands separator too", () => {
    expect(parseAmount("55,000")).toBe(55000);
  });

  it("reads a genuine decimal when the digit count says so", () => {
    expect(parseAmount("4,50")).toBe(4.5);
    expect(parseAmount("62.5")).toBe(62.5);
  });

  it("resolves both separators by taking the last as the decimal mark", () => {
    expect(parseAmount("4.500,50")).toBe(4500.5);
    expect(parseAmount("4,500.50")).toBe(4500.5);
  });

  it("reads repeated separators as thousands grouping", () => {
    expect(parseAmount("1.234.567")).toBe(1234567);
  });

  it("expands a k suffix", () => {
    expect(parseAmount("55K")).toBe(55000);
    expect(parseAmount("€55k")).toBe(55000);
  });

  it("strips the Dutch no-cents suffix", () => {
    expect(parseAmount("€ 4.357,-")).toBe(4357);
  });

  it("returns null on unreadable input rather than guessing", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("competitive")).toBeNull();
  });
});

describe("extractSalary", () => {
  it("reads a monthly range with its unit", () => {
    const s = extractSalary("Wij bieden €4.500 - €6.000 per maand.");
    expect(s.min).toBe(4500);
    expect(s.max).toBe(6000);
    expect(s.unit).toBe("monthly");
    expect(s.unitInferred).toBe(false);
  });

  it("reads an annual figure with its unit", () => {
    const s = extractSalary("Salary: €70.000 per year.");
    expect(s.max).toBe(70000);
    expect(s.unit).toBe("annual");
  });

  it("reads an hourly contract rate", () => {
    const s = extractSalary("Rate: €65 per hour, freelance.");
    expect(s.max).toBe(65);
    expect(s.unit).toBe("hourly");
  });

  it("infers the unit from magnitude when none is stated", () => {
    const s = extractSalary("Salary: €70.000.");
    expect(s.unit).toBe("annual");
    expect(s.unitInferred).toBe(true);
  });

  it("detects an included holiday allowance", () => {
    const s = extractSalary("€55.000 per jaar incl. 8% vakantiegeld.");
    expect(s.holidayBasis).toBe("included");
  });

  it("detects an excluded holiday allowance", () => {
    const s = extractSalary("€55.000 per jaar exclusief vakantiegeld.");
    expect(s.holidayBasis).toBe("excluded");
  });

  it("leaves the holiday basis unstated when the posting is silent", () => {
    expect(extractSalary("€55.000 per jaar.").holidayBasis).toBe("unstated");
  });

  it("reports no figure when the posting states none", () => {
    const s = extractSalary("Competitive salary and great benefits.");
    expect(s.unit).toBe("none");
    expect(s.max).toBeUndefined();
  });

  it("handles an en-dash range and a 'tot' range", () => {
    expect(extractSalary("€4.500 – €6.000 per maand").max).toBe(6000);
    expect(extractSalary("van €4.500 tot €6.000 per maand").max).toBe(6000);
  });

  it("keeps the matched substring so evidence can quote the posting", () => {
    expect(extractSalary("Salary €70.000 per year.").raw).toContain("70.000");
  });
});

describe("extractFteFactor", () => {
  it("reads part-time hours as a fraction of full time", () => {
    expect(extractFteFactor("32 uur per week")).toBeCloseTo(0.8);
    expect(extractFteFactor("36 hours per week")).toBeCloseTo(0.9);
  });

  it("reads an explicit FTE fraction in either decimal convention", () => {
    expect(extractFteFactor("0,8 FTE")).toBeCloseTo(0.8);
    expect(extractFteFactor("0.8 fte")).toBeCloseTo(0.8);
  });

  it("reads a four-day week", () => {
    expect(extractFteFactor("This is a 4-day role.")).toBeCloseTo(0.8);
  });

  it("returns undefined for full time, so evidence stays quiet", () => {
    expect(extractFteFactor("40 uur per week")).toBeUndefined();
    expect(extractFteFactor("1.0 FTE")).toBeUndefined();
    expect(extractFteFactor("No hours mentioned")).toBeUndefined();
  });
});

describe("extractLanguage", () => {
  it("catches a hard Dutch requirement written in Dutch", () => {
    // The confirmed false PASS in the predecessor.
    expect(extractLanguage("Vloeiend Nederlands is vereist.").dutchRequired).toBe("yes");
    expect(extractLanguage("Uitstekende beheersing van de Nederlandse taal.").dutchRequired).toBe("yes");
    expect(extractLanguage("Je spreekt vloeiend Nederlands.").dutchRequired).toBe("yes");
  });

  it("catches the bare phrasing that carries no separate language word", () => {
    // "Nederlands is vereist" has no word like taal/spreken/vloeiend in it — in
    // Dutch the language noun IS the mention. A context-word test alone reads
    // this sentence as irrelevant and passes the posting, which is precisely the
    // defect this module was written to close.
    expect(extractLanguage("Nederlands is vereist voor deze functie.").dutchRequired).toBe("yes");
    expect(extractLanguage("Nederlands vereist.").dutchRequired).toBe("yes");
    expect(extractLanguage("Goede beheersing van het Nederlands is noodzakelijk.").dutchRequired).toBe("yes");
  });

  it("does not read an unrelated requirement near a Dutch mention as a language bar", () => {
    // The false positive the proximity window has to stay tight enough to avoid.
    // Rejecting this posting would be a silent loss of a perfectly good role.
    expect(
      extractLanguage("We are a Dutch company where experience with Python is required.").dutchRequired,
    ).toBe("no");
  });

  it("catches a hard Dutch requirement written in English", () => {
    expect(extractLanguage("Fluent Dutch language skills are required.").dutchRequired).toBe("yes");
  });

  it("keeps a role in play when Dutch is only a preference", () => {
    expect(extractLanguage("Dutch language skills are a nice to have.").dutchRequired).toBe("no");
    expect(extractLanguage("Nederlands spreken is een pluspunt.").dutchRequired).toBe("no");
  });

  it("does not treat a Dutch COMPANY as a Dutch language requirement", () => {
    // Sentence scoping — otherwise a large share of the market lands in the queue.
    expect(extractLanguage("We are a Dutch company serving the Dutch market.").dutchRequired).toBe("no");
    expect(extractLanguage("Join our team in the Netherlands.").dutchRequired).toBe("no");
  });

  it("does not let a language sentence elsewhere contaminate an unrelated one", () => {
    const facts = extractLanguage("We are a Dutch company. English is our working language.");
    expect(facts.dutchRequired).toBe("no");
  });

  it("returns unstated when Dutch is discussed without a requirement or softener", () => {
    expect(extractLanguage("The team language is Dutch and English.").dutchRequired).toBe("unstated");
  });
});

describe("extractRoute", () => {
  it("identifies a remote contract", () => {
    expect(extractRoute("Fully remote freelance contract, ZZP.")).toBe("remote-contract");
    expect(extractRoute("We are hiring a contractor, 100% remote.")).toBe("remote-contract");
  });

  it("identifies an on-site sponsorship role", () => {
    expect(extractRoute("On-site in Amsterdam, visa sponsorship available.")).toBe("hsm");
    expect(extractRoute("Hybrid role with relocation support.")).toBe("hsm");
  });

  it("returns unclear when markers conflict or are absent", () => {
    // Unclear is a real answer: the caller screens both routes rather than guess.
    expect(extractRoute("Remote-first team with a hybrid office in Amsterdam.")).toBe("unclear");
    expect(extractRoute("We are hiring an AI engineer.")).toBe("unclear");
  });
});

describe("parseAmount — trailing sentence punctuation", () => {
  it("does not let a trailing full stop flip the decimal reading", () => {
    // Live regression 2026-07-29: "€2,95." parsed as 295, which at full-time
    // hours became a €613,600 ceiling and PASSED the salary gate on a posting
    // that stated no salary at all.
    expect(parseAmount("€2,95.")).toBe(2.95);
    expect(parseAmount("€2,95")).toBe(2.95);
  });

  it("still reads real thousands grouping", () => {
    expect(parseAmount("€55.000")).toBe(55000);
    expect(parseAmount("€67,300")).toBe(67300);
    expect(parseAmount("€55.000.")).toBe(55000);
  });

  it("ignores a trailing comma", () => {
    expect(parseAmount("€4.357,")).toBe(4357);
  });
});
