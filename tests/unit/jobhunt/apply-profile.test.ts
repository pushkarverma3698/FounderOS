/**
 * Unit tests — the apply profile.
 *
 * The file this covers is the one whose absence produced the whole defect:
 * `mac-client` refuses to open a browser without `apply-profile.json`, that file
 * was never copied from its example, and the LaunchAgent announced "4 jobs
 * ready" in Telegram on every wake for three weeks while every run died on line
 * one. Two applications in twenty-one days.
 *
 * So the properties are about not repeating that in the other direction — a
 * profile that silently half-works is worse than one that is loudly absent:
 *
 *   · an unparseable or invalid file is a REASON, never an empty profile
 *   · an edit that would break the profile is refused before it is written
 *   · a value keeps its spaces, because phone numbers and cities have them
 *   · work authorisation is a CLOSED SET, and defaults to `unknown` — which
 *     leaves every eligibility question blank rather than guessing
 */

import { describe, it, expect } from "vitest";
import {
  parseApplyProfile,
  renderApplyProfile,
  setProfileField,
} from "../../../src/tools/jobhunt/apply-profile.js";
import { parseProfileCommand } from "../../../src/gateway/profile-commands.js";

const VALID = {
  first_name: "Pushkar",
  last_name: "Verma",
  email: "pushkar3698@gmail.com",
  phone: "+91 97792 60517",
  answers: { work_authorization: "requires-sponsorship", years_experience: 3.5 },
};

describe("parseApplyProfile", () => {
  it("accepts a profile with the four fields an ATS always asks for", () => {
    const read = parseApplyProfile(JSON.stringify(VALID));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.profile.email).toBe("pushkar3698@gmail.com");
  });

  it("names every problem at once, not one per round trip", () => {
    // He reads this on a phone. One missing field per message is a bad trade.
    const read = parseApplyProfile(JSON.stringify({ first_name: "", email: "nope" }));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain("first_name");
      expect(read.reason).toContain("email");
      expect(read.reason).toContain("last_name");
    }
  });

  it("reports malformed JSON as a reason rather than throwing", () => {
    const read = parseApplyProfile('{"first_name": "Pushk');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("not valid JSON");
  });

  it("refuses a work_authorization outside the closed set", () => {
    // Free text here would force the form filler to interpret a sentence about
    // visa status, which is the one operation that must never be automatic.
    const read = parseApplyProfile(
      JSON.stringify({ ...VALID, answers: { work_authorization: "probably fine" } }),
    );
    expect(read.ok).toBe(false);
  });

  it("keeps unknown keys, so a field the schema has not learned yet survives an edit", () => {
    const read = parseApplyProfile(JSON.stringify({ ...VALID, _source: "cv-master.md" }));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.raw["_source"]).toBe("cv-master.md");
  });
});

describe("renderApplyProfile", () => {
  it("names the fields that are NOT set", () => {
    // A view listing only what is present cannot explain why a form came back
    // with six blanks, and six blanks is the state this file exists to expose.
    const read = parseApplyProfile(JSON.stringify(VALID));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const out = renderApplyProfile(read.profile);
    expect(out).toContain("LinkedIn");
    expect(out).toContain("not set");
  });

  it("warns loudly when right-to-work is unset", () => {
    const read = parseApplyProfile(JSON.stringify({ ...VALID, answers: {} }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(renderApplyProfile(read.profile)).toContain("Right to work is not set");
  });
});

describe("setProfileField", () => {
  it("sets a top-level field without mutating the original", () => {
    const raw = { ...VALID } as Record<string, unknown>;
    const out = setProfileField(raw, "phone", "+31 6 12345678");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.next["phone"]).toBe("+31 6 12345678");
    expect(raw["phone"]).toBe("+91 97792 60517");
  });

  it("sets a nested field and keeps its siblings", () => {
    const out = setProfileField({ ...VALID } as Record<string, unknown>, "answers.years_experience", "4");
    expect(out.ok).toBe(true);
    if (out.ok) {
      const answers = out.next["answers"] as Record<string, unknown>;
      expect(answers["years_experience"]).toBe(4);
      expect(answers["work_authorization"]).toBe("requires-sponsorship");
    }
  });

  it("coerces numbers and booleans, because Telegram only sends strings", () => {
    const n = setProfileField({}, "answers.salary_floor_eur_year", "52284");
    const b = setProfileField({}, "answers.willing_to_relocate", "true");
    expect(n.ok && (n.next["answers"] as Record<string, unknown>)["salary_floor_eur_year"]).toBe(52284);
    expect(b.ok && (b.next["answers"] as Record<string, unknown>)["willing_to_relocate"]).toBe(true);
  });

  it("refuses a path deeper than section.field", () => {
    expect(setProfileField({}, "a.b.c", "x").ok).toBe(false);
  });

  it("refuses to edit the resume map from Telegram", () => {
    // Those are absolute paths on the founder's Mac. A typo there means the
    // client cannot find a CV, which surfaces only when a form is already open.
    expect(setProfileField({}, "resumes", "/tmp/x.pdf").ok).toBe(false);
  });
});

describe("parseProfileCommand", () => {
  it("treats a bare /profile as show", () => {
    expect(parseProfileCommand("")).toEqual({ kind: "show" });
  });

  it("keeps the spaces inside a value", () => {
    // "+31 6 12 34 56 78" and "Amsterdam, North Holland" are ordinary answers.
    // Splitting on every space would store "+31" as the phone number.
    expect(parseProfileCommand("set phone +31 6 12 34 56 78")).toEqual({
      kind: "set",
      path: "phone",
      value: "+31 6 12 34 56 78",
    });
  });

  it("handles a nested path", () => {
    expect(parseProfileCommand("set answers.location_city Amsterdam")).toEqual({
      kind: "set",
      path: "answers.location_city",
      value: "Amsterdam",
    });
  });

  it("asks for a value rather than storing an empty one", () => {
    expect(parseProfileCommand("set phone").kind).toBe("usage");
  });

  it("refuses a verb it does not know instead of guessing", () => {
    expect(parseProfileCommand("delete phone").kind).toBe("usage");
  });
});
