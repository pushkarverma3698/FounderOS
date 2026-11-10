/**
 * Unit tests — a posting whose country is `unknown` no longer passes silently.
 *
 * PROD AUDIT, 2026-11-03..10, profile pushkar-nl-tech: 60 of the 277 passed or
 * flagged roles had country='unknown' (Ramp "Remote", ElevenLabs "Remote", Abnormal
 * Security with a blank location, Lemonade "EU", YLD "Remote EU", Canonical "EMEA").
 * `locationGate` only raised its question when the ad's route was `unclear`; an ad
 * that said "contractor" or "remote-first" routed as `remote-contract` and the gate
 * went quiet, so a US-only role passed on a basis nobody had established.
 *
 * Nothing here rejects: a role lawful for him must stay reachable. The contract is
 * flag-with-reason, and a region (EU / EMEA) is a remote-contract basis, not a country.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecord = vi.fn(async (row: Record<string, unknown>) => ({ id: "ja1", ...row }));
vi.mock("../../../src/db/cv-signal-queries.js", () => ({
  recordSignals: vi.fn(async () => 0),
  listSignals: vi.fn(async () => []),
  UNCLASSIFIED_TRACK: "unclassified",
}));
vi.mock("../../../src/db/job-queries.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  findApplicationByDedupeKey: vi.fn(async () => null),
  findApplicationsBySoftKey: vi.fn(async () => []),
  recordScreenedApplication: mockRecord,
}));

const { screenPosting } = await import("../../../src/tools/jobhunt/screen.js");
const { remoteScope } = await import("../../../src/tools/jobhunt/remote-scope.js");
const { locationGate } = await import("../../../src/tools/jobhunt/screen-gates.js");

beforeEach(() => vi.clearAllMocks());

const FILLER =
  "You will build and operate backend services in Python and TypeScript, own them end to end, " +
  "review code, and work with product on what ships next. We value clear writing and small, " +
  "well-tested changes. Three or more years of production experience is a good fit. " +
  "Benefits include a learning budget, equipment, and flexible hours across the team. ";

async function screen(company: string, title: string, location: string, extra: string) {
  const outcome = await screenPosting({
    company,
    title,
    location,
    description: FILLER + extra,
    source: "free-ats-ingest",
  });
  if (outcome.kind !== "screened") throw new Error(`expected screened, got ${outcome.kind}`);
  return outcome;
}

const locationOf = (o: Awaited<ReturnType<typeof screen>>) => o.verdict.gates.find((g) => g.gate === "Location");

describe("remoteScope", () => {
  it("reads US-only wording out of the body", () => {
    expect(remoteScope("", "Candidates must be based in the United States.")).toBe("us-only");
    expect(remoteScope("Remote", "This role is US only.")).toBe("us-only");
    expect(remoteScope("Remote", "You must reside in the U.S. and be authorized to work in the US.")).toBe("us-only");
  });
  it("reads a European region off the location", () => {
    expect(remoteScope("EU", "")).toBe("eu-region");
    expect(remoteScope("Remote EU", "")).toBe("eu-region");
    expect(remoteScope("EMEA", "")).toBe("eu-region");
    expect(remoteScope("Remote, Europe", "")).toBe("eu-region");
  });
  it("a freelance or B2B engagement is its own scope", () => {
    expect(remoteScope("Remote", "Fully remote freelance contract. 60 euro per hour.")).toBe("contract");
  });
  it("a bare Remote or blank location says nothing", () => {
    expect(remoteScope("Remote", FILLER)).toBe("unscoped");
    expect(remoteScope("", FILLER)).toBe("unscoped");
  });
  it("US-only wording beats a European region", () => {
    expect(remoteScope("Remote EU", "US only")).toBe("us-only");
  });
  it("does not read 'us' the pronoun as a country", () => {
    expect(remoteScope("Remote", "Join us. Tell us about your work with us.")).toBe("unscoped");
  });
});

describe("locationGate — unknown country with a remote-contract route", () => {
  it("flags instead of staying silent", () => {
    const gate = locationGate("unknown", "remote-contract");
    expect(gate?.status).toBe("flag");
  });
  it("stays silent for an explicit freelance contract: billed from anywhere", () => {
    expect(locationGate("unknown", "remote-contract", "contract")).toBeNull();
  });
  it("still stays silent when the ad itself implies the Netherlands (hsm)", () => {
    expect(locationGate("unknown", "hsm")).toBeNull();
  });
});

describe("prod examples, screened end to end", () => {
  it("Ramp, location 'Remote', contractor wording: flagged, never silently passed", async () => {
    const o = await screen("Ramp", "Software Engineer, Backend, Comms Platform", "Remote",
      "This is a fully remote, remote-first team.");
    expect(o.verdict.status).not.toBe("pass");
    expect(locationOf(o)?.status).toBe("flag");
  });
  it("ElevenLabs, location 'Remote': flagged", async () => {
    const o = await screen("ElevenLabs", "Full-Stack Engineer", "Remote", "Work from anywhere, remote-first.");
    expect(locationOf(o)?.status).toBe("flag");
  });
  it("Abnormal Security, blank location, US-only body: flagged with the US reason", async () => {
    const o = await screen("Abnormal Security", "Software Engineer, Platform", "",
      "Candidates must be based in the United States. Fully remote.");
    expect(locationOf(o)?.status).toBe("flag");
    expect(locationOf(o)?.evidence).toMatch(/US/);
    expect(o.route).toBe("remote-contract");
  });
  it.each([
    ["Lemonade", "Backend Engineer", "EU"],
    ["YLD", "Senior Java Engineer", "Remote EU"],
    ["Canonical", "Python Software Engineer", "EMEA"],
  ])("%s, location %s: a remote-contract basis, flagged with the region reason", async (company, title, location) => {
    const o = await screen(company, title, location, "");
    expect(o.route).toBe("remote-contract");
    expect(locationOf(o)?.status).toBe("flag");
    expect(locationOf(o)?.evidence).toMatch(/EU|Europe|region/i);
  });
  it("a Dutch location is untouched", async () => {
    const o = await screen("Acme B.V.", "Backend Engineer", "Amsterdam, Netherlands", "");
    expect(locationOf(o)).toBeUndefined();
  });
});
