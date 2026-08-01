/**
 * Unit tests — the stated-years gate.
 *
 * Founder direction, 2026-08-01: "Reject the jobs which require more than 4
 * years of experience… no one will give a job to a 3 year or 4 year of
 * experience while applying for platform engineer."
 *
 * The interesting half of this gate is what it must NOT do. A wrong reject
 * silently removes a real opportunity and emits no signal that it did — the
 * failure direction this pipeline has already been wrong in twice. So the tests
 * lean on the false-positive cases: a company advertising its own age, a range
 * whose floor is reachable, and a "Senior" title with no number behind it.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_YEARS_DEMANDED,
  experienceGate,
  extractExperienceDemand,
  isLeadershipTitle,
  isSeniorTitle,
} from "../../../src/tools/jobhunt/experience.js";

describe("extractExperienceDemand", () => {
  it("reads a plain demand", () => {
    expect(extractExperienceDemand("You have 6 years of experience with Go.").minYears).toBe(6);
  });

  it("reads the '+' form", () => {
    expect(extractExperienceDemand("8+ years of experience running platforms.").minYears).toBe(8);
  });

  it("takes the FLOOR of a range, not the ceiling", () => {
    // "3-5 years" is a role a 3.5-year candidate is squarely inside. Reading the
    // ceiling would reject roles the employer wrote to include him.
    expect(extractExperienceDemand("3-5 years of experience in backend.").minYears).toBe(3);
    expect(extractExperienceDemand("2 to 6 years of experience required.").minYears).toBe(2);
  });

  it("takes the LOWEST figure when several are stated", () => {
    // "3 years backend, 5 years with Kubernetes preferred" — the entry bar is 3
    // and everything above it is a wish list.
    const text =
      "You have 3 years of experience building APIs. 7 years of experience with " +
      "Kubernetes is a plus.";
    expect(extractExperienceDemand(text).minYears).toBe(3);
  });

  it("reads Dutch", () => {
    expect(extractExperienceDemand("Minimaal 6 jaar ervaring met Java.").minYears).toBe(6);
  });

  it("ignores a company advertising its own age", () => {
    // The single most common false positive, and the one that would reject a
    // graduate-friendly employer on the strength of its own marketing.
    const text = "We have over 20 years of experience serving the Dutch market.";
    expect(extractExperienceDemand(text).minYears).toBeNull();
  });

  it("ignores an implausible figure", () => {
    expect(extractExperienceDemand("30 years of experience in logistics.").minYears).toBeNull();
  });

  it("returns null when no figure is stated, rather than zero", () => {
    // An unstated requirement is UNKNOWN, not absent. Zero would compare as
    // "requires nothing" and quietly pass a role nobody had measured.
    expect(extractExperienceDemand("You will own services end to end.").minYears).toBeNull();
  });

  it("does not carry a match from one sentence into the next", () => {
    // Regression for the /g regex `lastIndex` trap: a shared regex resumes
    // scanning wherever the previous call stopped, so the second sentence's
    // figure gets skipped and the gate silently under-reads the demand.
    const text = "We have 15 years of experience. You bring 9 years of experience in Go.";
    expect(extractExperienceDemand(text).minYears).toBe(9);
  });

  it("quotes the sentence it decided from", () => {
    const demand = extractExperienceDemand("You bring 9 years of experience in Go.");
    expect(demand.evidence).toContain("9 years of experience");
  });
});

describe("experienceGate", () => {
  const BODY = "You will own services end to end and work in English. ";

  it(`rejects above ${MAX_YEARS_DEMANDED} stated years`, () => {
    const gate = experienceGate(`${BODY}8+ years of experience required.`, "Platform Engineer");
    expect(gate.status).toBe("reject");
    expect(gate.evidence).toContain("8 years minimum");
  });

  it("passes at exactly the ceiling", () => {
    const gate = experienceGate(`${BODY}4 years of experience required.`, "Backend Engineer");
    expect(gate.status).toBe("pass");
  });

  it("does NOT reject a Senior title on its own", () => {
    // Founder decision, 2026-08-01: reject on stated years only. "Senior" means
    // four different things at four companies, and a Dutch scale-up's Senior
    // Engineer is routinely a four-year role. Rejecting on the label would
    // discard reachable roles by the dozen and say nothing about having done so.
    const gate = experienceGate(`${BODY}You will mentor others.`, "Senior Platform Engineer");
    expect(gate.status).toBe("pass");
  });

  it("says out loud when no figure was stated", () => {
    const gate = experienceGate(`${BODY}You will mentor others.`, "Backend Engineer");
    expect(gate.status).toBe("pass");
    expect(gate.evidence).toContain("states no number of years");
  });

  it("notes the senior label on a passing row without acting on it", () => {
    const gate = experienceGate(`${BODY}3 years of experience needed.`, "Senior Engineer");
    expect(gate.status).toBe("pass");
    expect(gate.evidence).toContain("the stated bar is what counts");
  });

  it("rejects an internship, and says it is keeping the record", () => {
    // These used to be dropped before screening, so they never reached the table
    // and the founder could not audit what had been thrown away for him.
    const gate = experienceGate(BODY, "Software Engineer Intern");
    expect(gate.status).toBe("reject");
    expect(gate.evidence).toContain("Kept on record");
  });

  it("rejects a graduate scheme", () => {
    expect(experienceGate(BODY, "Graduate Software Engineer (2027)").status).toBe("reject");
  });
});

describe("department-lead titles", () => {
  const BODY = "You will own services end to end and work in English. ";

  it("FLAGS a Director role rather than leading APPLY TODAY with it", () => {
    // "Director of AI Engineering" sat at position 1 of APPLY TODAY on
    // 2026-08-01 precisely because it named no year count. It flags, not
    // rejects: rejecting on a title alone is what the founder ruled out, and a
    // flag is the loud, reversible direction — the role still appears, one
    // question away, instead of leading the list of things to do before work.
    const gate = experienceGate(BODY, "Director of AI Engineering");
    expect(gate.status).toBe("flag");
    expect(gate.evidence).toContain("runs a department");
  });

  it("flags a leadership title even when the stated years are reachable", () => {
    const gate = experienceGate(`${BODY}3 years of experience needed.`, "Head of Engineering");
    expect(gate.status).toBe("flag");
  });

  it("still REJECTS a leadership title that states too many years", () => {
    // The hard bar wins over the softer one.
    const gate = experienceGate(`${BODY}10 years of experience required.`, "VP of Engineering");
    expect(gate.status).toBe("reject");
  });

  it("leaves ordinary senior and lead titles in the pool", () => {
    // A Dutch scale-up's "Senior Engineer" is routinely a four-year role, and
    // "Tech Lead" is an ordinary senior-engineer title in half the market.
    expect(experienceGate(BODY, "Senior Backend Engineer").status).toBe("pass");
    expect(experienceGate(BODY, "Tech Lead, Payments").status).toBe("pass");
    expect(experienceGate(BODY, "Staff Software Engineer").status).toBe("pass");
  });

  it("recognises the department-lead vocabulary", () => {
    expect(isLeadershipTitle("VP of Engineering")).toBe(true);
    expect(isLeadershipTitle("Chief Technology Officer")).toBe(true);
    expect(isLeadershipTitle("Backend Engineer")).toBe(false);
    expect(isLeadershipTitle("Team Lead, Software Engineering")).toBe(false);
  });
});

describe("isSeniorTitle", () => {
  it("recognises the labels without treating them as evidence", () => {
    expect(isSeniorTitle("Staff Engineer")).toBe(true);
    expect(isSeniorTitle("Principal Backend Engineer")).toBe(true);
    expect(isSeniorTitle("Backend Engineer")).toBe(false);
  });

  it("does not read 'senior' inside another word", () => {
    expect(isSeniorTitle("Seniority Systems Engineer")).toBe(false);
  });
});
