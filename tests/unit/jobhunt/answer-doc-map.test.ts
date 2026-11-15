/**
 * mapAnswersToProfile: structured fields vs dossier Q&A, closed-set right-to-work and self-identification,
 * skip and blank. Invented candidate; no model calls.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnswerDoc } from "../../../src/tools/jobhunt/answer-doc-parse.js";
import { mapAnswersToProfile, parseYearlyEuro, type AnswerPatch, type FieldWrite } from "../../../src/tools/jobhunt/answer-doc-map.js";

const messy = readFileSync(new URL("../../fixtures/answer-docs/messy-mira.md", import.meta.url), "utf8");
const patchOf = (text: string): AnswerPatch => mapAnswersToProfile(parseAnswerDoc(text));
const field = (p: AnswerPatch, f: string): FieldWrite | undefined => p.writes.find((w) => ("field" in w && w.field === f) || (w.kind === "selfid" && w.category === f));
const val = (p: AnswerPatch, f: string): unknown => (field(p, f) as { value?: unknown } | undefined)?.value;
const doc = (n: number, stem: string, answer: string): string => `${n}. ${stem}\n${answer}\n`;

describe("mapAnswersToProfile on the messy document", () => {
  const p = patchOf(messy);

  it("fills the structured fields the profile has keys for", () => {
    expect(val(p, "first_name")).toBe("Mira");
    expect(val(p, "last_name")).toBe("Haldane");
    expect(val(p, "email")).toBe("mira.haldane@example.test");
    expect(val(p, "phone")).toBe("+31 6 5550 0142");
    expect(val(p, "location_city")).toBe("Utrecht");
    expect(val(p, "location_country")).toBe("Netherlands");
    expect(val(p, "notice_period_days")).toBe(60);
    expect(val(p, "salary_floor_eur_year")).toBe(54000);
    expect(val(p, "willing_to_relocate")).toBe(true);
  });

  it("files everything else as dossier Q&A in her words", () => {
    const qa = p.writes.filter((w) => w.kind === "qa");
    expect(qa).toContainEqual(expect.objectContaining({ question: "Nationality", value: "Fictionlander" }));
    expect(qa).toContainEqual(expect.objectContaining({ question: "Are you currently employed?", value: "Yes" }));
    expect(qa).toContainEqual(expect.objectContaining({ question: "Earliest start date", value: "Q: 1 March 2027" }));
  });

  it("holds skipped and blank answers and writes nothing for them", () => {
    const heldLabels = p.held.map((h) => `${h.label}|${h.reason}`);
    expect(heldLabels).toContain("Postal address|skipped: asked on each form");
    expect(heldLabels).toContain("Current salary|skipped: asked on each form");
    expect(heldLabels).toContain("LinkedIn|blank: unknown");
    expect(p.writes.some((w) => w.number === 5 || w.number === 20 || w.number === 6)).toBe(false);
  });

  it("never lets a right-to-work answer reach the dossier Q&A", () => {
    const qaNumbers = p.writes.filter((w) => w.kind === "qa").map((w) => w.number);
    for (const n of [8, 9, 10, 11, 39, 40, 41]) expect(qaNumbers).not.toContain(n);
  });

  it("sets work authorisation only from a plain yes/no pair, and keeps the permit text as detail", () => {
    expect(val(p, "work_authorization")).toBe("authorized-no-sponsorship");
    expect(val(p, "work_authorization_detail")).toBe("Netherlands permit: Highly skilled migrant dependant permit, valid until 2028-03; India right to work: yes");
  });

  it("copies the voluntary answers as written, per category", () => {
    expect(val(p, "gender")).toBe("prefer not to say");
    expect(val(p, "disability")).toBe("No");
  });
});

describe("closed-set answers", () => {
  const allowed = "Netherlands: are you legally allowed to work there today? (yes / no)";
  const sponsor = "Netherlands: do you need the employer to sponsor a visa or work permit, now or in the future? (yes / no)";

  it("a yes to sponsorship means requires-sponsorship", () => {
    expect(val(patchOf(doc(8, allowed, "yes") + doc(9, sponsor, "yes")), "work_authorization")).toBe("requires-sponsorship");
  });

  it("a loose answer is held, not interpreted, and not stored anywhere", () => {
    const p = patchOf(doc(8, allowed, "yes, on a dependent permit") + doc(9, sponsor, "no"));
    expect(field(p, "work_authorization")).toBeUndefined();
    expect(p.writes.filter((w) => w.number === 8)).toEqual([]);
    expect(p.held.find((h) => h.number === 8)?.reason).toMatch(/not a plain yes or no/);
  });

  it("only a no to sponsorship, with no answer on Q8, does not decide authorisation", () => {
    expect(field(patchOf(doc(9, sponsor, "no")), "work_authorization")).toBeUndefined();
  });

  it("a prefer-not-to-say is stored as written", () => {
    expect(val(patchOf(doc(41, "Ethnicity (asked on some forms, mostly US companies): your answer, or \"prefer not to say\".", "Prefer not to say")), "race")).toBe("Prefer not to say");
  });
});

describe("value parsing is strict", () => {
  it("salary: euros per year only, months multiplied, ambiguity falls back to Q&A", () => {
    expect(parseYearlyEuro("€65,000 gross per year")).toBe(65000);
    expect(parseYearlyEuro("65k")).toBe(65000);
    expect(parseYearlyEuro("5.500 per month")).toBe(66000);
    expect(parseYearlyEuro("3000")).toBeNull();
    expect(parseYearlyEuro("₹12,00,000 per year")).toBeNull();
    expect(parseYearlyEuro("60-70k")).toBeNull();
    const p = patchOf(doc(21, "Expected salary for the Netherlands (gross, per year or per month).", "around 3000"));
    expect(field(p, "salary_floor_eur_year")).toBeUndefined();
    expect(p.writes.some((w) => w.kind === "qa" && w.value === "around 3000")).toBe(true);
  });

  it("notice: days become a number and clear a stale detail; words stay as detail", () => {
    const days = patchOf(doc(14, "Notice period in days.", "30 days"));
    expect(val(days, "notice_period_days")).toBe(30);
    expect(val(days, "notice_period_detail")).toBeNull();
    const words = patchOf(doc(14, "Notice period in days.", "two months"));
    expect(val(words, "notice_period_detail")).toBe("two months");
    expect(val(words, "notice_period_days")).toBeNull();
  });

  it("rejects an email, phone or link that is not one", () => {
    const p = patchOf(doc(2, "Email address to use for job applications.", "not given") + doc(3, "Phone number with country code.", "call me") + doc(6, "LinkedIn profile link.", "on request"));
    expect(p.writes).toEqual([]);
    expect(p.held.map((h) => h.number)).toEqual([2, 3, 6]);
  });

  it("splits a title and employer only on at or @", () => {
    const q = "Current or most recent job title and employer.";
    expect(val(patchOf(doc(27, q, "Senior Analyst at Northwind BV")), "current_title")).toBe("Senior Analyst");
    expect(val(patchOf(doc(27, q, "Senior Analyst at Northwind BV")), "current_company")).toBe("Northwind BV");
    expect(patchOf(doc(27, q, "Analyst, Northwind")).writes[0]).toMatchObject({ kind: "qa", value: "Analyst, Northwind" });
  });

  it("a name with one word is held, and a single-part location is kept as Q&A only", () => {
    expect(patchOf(doc(1, "Full name exactly as it should appear on applications.", "Mira")).held).toHaveLength(1);
    const loc = patchOf(doc(4, "Current city and country.", "Utrecht"));
    expect(field(loc, "location_city")).toBeUndefined();
    expect(loc.writes[0]).toMatchObject({ kind: "qa", value: "Utrecht" });
  });
});
