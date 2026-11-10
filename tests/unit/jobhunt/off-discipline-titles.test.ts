/**
 * Unit tests — a title led by a non-software discipline is not one of his tracks.
 *
 * PROD AUDIT, 2026-11-03..10: these titles all classified into a track because one
 * generic word ("AI", "Platform", "Linux", "Java developer", "DevOps Engineer", a
 * role noun) matched, while the discipline that dominates the title (mechanical CAD,
 * SAP, a kernel, UX design, Atlassian Confluence, a KDB+/Q trading stack) is not
 * software work he does. The real tracks must keep passing.
 */

import { describe, it, expect } from "vitest";
import { classifyTrack } from "../../../src/tools/jobhunt/tracks.js";
import { PUSHKAR_PROFILE, getProfile } from "../../../src/tools/jobhunt/profile-config.js";

describe("classifyTrack — off-discipline titles (prod examples)", () => {
  it.each([
    "Freelance Mechanical CAD&Simulation Engineer - AI Trainer",
    "Senior SAP BODS/BO Platform Admin & Developer",
    "Linux kernel developer_BSH",
    "UX Designer/ Java developer",
    "Product Specialist / Platform Engineer, Atlassian Confluence",
    "Equities KDB Plus and Q DevOps Engineer",
  ])("returns null for %s", (title) => {
    expect(classifyTrack(title, PUSHKAR_PROFILE)).toBeNull();
  });
});

describe("classifyTrack — his real tracks still pass", () => {
  it.each([
    ["Senior AI Engineer", "ai"],
    ["Machine Learning Engineer, Applied AI", "ai"],
    ["Full Stack Software Engineer", "fullstack"],
    ["Full-Stack Engineer", "fullstack"],
    ["Backend Engineer (Java)", "backend"],
    ["Java Developer", "backend"],
    ["Python Developer - Payments", "backend"],
    ["Senior DevOps Engineer", "backend"],
    ["Site Reliability Engineer", "backend"],
    ["Platform Engineer", "backend"],
    ["Data Engineer", "backend"],
    ["Software Engineer, Backend, Comms Platform", "backend"],
    ["Frontend Engineer, Design Systems", "frontend"],
    ["Senior Software Engineer - Linux Platform", "backend"],
  ])("%s -> %s", (title, track) => {
    expect(classifyTrack(title, PUSHKAR_PROFILE)).toBe(track);
  });
});

describe("classifyTrack — a finance profile is not subject to the tech discipline list", () => {
  it("keeps 'SAP' finance roles for the finance candidate", () => {
    const wife = getProfile("wife-nl-finance");
    expect(classifyTrack("SAP FICO Finance Controller", wife)).not.toBeNull();
  });
});
