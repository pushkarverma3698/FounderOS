/**
 * Unit tests — early-career title exclusion.
 *
 * The real titles below are the ACTUAL contents of the production job table on
 * 2026-08-01. Half the day's budget was spent on them.
 */

import { describe, it, expect } from "vitest";
import { isEarlyCareerTitle, excludeEarlyCareer } from "../../../src/tools/jobhunt/seniority.js";

describe("isEarlyCareerTitle", () => {
  it("drops the exact titles that filled the live pipeline", () => {
    for (const title of [
      "Software Engineer Intern",
      "Graduate Software Engineer (2027)",
      "Working Student — Backend",
      "Werkstudent Data Engineer",
      "Stagiair Frontend Developer",
      "Trainee Software Engineer",
      "Engineering Graduate Programme 2027",
    ]) {
      expect(isEarlyCareerTitle(title), title).toBe(true);
    }
  });

  it("keeps the roles the campaign is actually for", () => {
    for (const title of [
      "AI Engineer",
      "Senior Frontend Engineer",
      "Full Stack Engineer",
      "Backend Engineer (m/f/d)",
      "React Developer",
      "Staff Machine Learning Engineer",
      "Embedded Software Engineer",
    ]) {
      expect(isEarlyCareerTitle(title), title).toBe(false);
    }
  });

  it("matches whole words only, so ordinary titles survive", () => {
    // "internal" contains "intern"; a substring match would have discarded a
    // real role and the drop would have been invisible.
    expect(isEarlyCareerTitle("Internal Tools Engineer")).toBe(false);
    expect(isEarlyCareerTitle("Engineer, Internal Platform")).toBe(false);
  });

  it("does not drop a role merely for carrying a year", () => {
    // A bare year is not a cohort marker: teams and products carry years too.
    expect(isEarlyCareerTitle("Engineer, Payments 2026 Team")).toBe(false);
    expect(isEarlyCareerTitle("Graduate Programme 2027")).toBe(true);
  });
});

describe("excludeEarlyCareer", () => {
  it("returns the kept postings and a COUNT of what it removed", () => {
    const postings = [
      { title: "AI Engineer" },
      { title: "Software Engineer Intern" },
      { title: "Senior React Developer" },
      { title: "Graduate Software Engineer (2027)" },
    ];

    const result = excludeEarlyCareer(postings);

    expect(result.kept.map((p) => p.title)).toEqual(["AI Engineer", "Senior React Developer"]);
    // The count is the whole point: a silent filter and an empty market look
    // identical, and this pipeline has already been wrong in that direction.
    expect(result.dropped).toBe(2);
    expect(result.droppedTitles).toContain("Software Engineer Intern");
  });

  it("drops nothing when every posting is mid-level", () => {
    const postings = [{ title: "AI Engineer" }, { title: "Backend Engineer" }];
    expect(excludeEarlyCareer(postings).dropped).toBe(0);
    expect(excludeEarlyCareer(postings).kept).toHaveLength(2);
  });
});
