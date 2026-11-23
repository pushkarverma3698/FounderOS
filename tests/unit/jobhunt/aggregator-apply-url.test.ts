/**
 * Arbeitnow rows store Arbeitnow's own page, which the VPS browser cannot open (Cloudflare) and which
 * has no application form. Its `/apply` link answers with a plain 302 to the employer's form; these
 * tests pin that resolution and every way it must fall back to the original URL.
 */

import { describe, it, expect, vi } from "vitest";
import { dropNoEmployerLink, hasNoEmployerLink, isArbeitnowUrl, resolveEmployerApplyUrl } from "../../../src/tools/jobhunt/aggregator-apply-url.js";
import { classifyFormUrl } from "../../../src/tools/jobhunt/form-platform.js";

const NL = "https://www.arbeitnow.nl/jobs/companies/adesso-netherlands/senior-data-scientist-utrecht-196103";
const EMPLOYER = "https://werkenbijadesso.recruitee.com/o/senior-data-scientist-1?utm_source=arbeitnow.nl&source=Arbeitnow";

function redirect(status: number, location: string | null): Response {
  return new Response(null, { status, headers: location === null ? {} : { location } });
}

describe("isArbeitnowUrl", () => {
  it("matches every Arbeitnow country site", () => {
    for (const host of ["www.arbeitnow.com", "www.arbeitnow.nl", "www.arbeitnow.co.uk", "arbeitnow.ch", "www.arbeitnow.fr"]) {
      expect(isArbeitnowUrl(`https://${host}/jobs/companies/x/y-1`)).toBe(true);
    }
  });
  it("does not match other hosts", () => {
    expect(isArbeitnowUrl("https://job-boards.greenhouse.io/affirm/jobs/1")).toBe(false);
    expect(isArbeitnowUrl("https://notarbeitnow.com/jobs/x")).toBe(false);
    expect(isArbeitnowUrl("not a url")).toBe(false);
  });
});

describe("resolveEmployerApplyUrl", () => {
  it("returns the employer form the /apply link redirects to", async () => {
    const fetchImpl = vi.fn(async () => redirect(302, EMPLOYER));
    expect(await resolveEmployerApplyUrl(NL, fetchImpl)).toBe(EMPLOYER);
    expect(fetchImpl).toHaveBeenCalledWith(`${NL}/apply`, expect.objectContaining({ redirect: "manual" }));
  });

  it("sends Accept: */* — Arbeitnow answers 403 to a request without it", async () => {
    let seen: RequestInit | undefined;
    await resolveEmployerApplyUrl(NL, async (_url, init) => {
      seen = init;
      return redirect(302, EMPLOYER);
    });
    expect((seen?.headers as Record<string, string>).Accept).toBe("*/*");
  });

  it("leaves non-Arbeitnow URLs alone without a request", async () => {
    const fetchImpl = vi.fn();
    const url = "https://jobs.lever.co/acme/123";
    expect(await resolveEmployerApplyUrl(url, fetchImpl)).toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the original URL when the posting is gone (410) or there is no redirect", async () => {
    expect(await resolveEmployerApplyUrl(NL, async () => redirect(410, null))).toBe(NL);
    expect(await resolveEmployerApplyUrl(NL, async () => new Response("ok", { status: 200 }))).toBe(NL);
    expect(await resolveEmployerApplyUrl(NL, async () => redirect(302, null))).toBe(NL);
  });

  it("keeps the original URL when the redirect stays on Arbeitnow or is not http(s)", async () => {
    expect(await resolveEmployerApplyUrl(NL, async () => redirect(302, "https://www.arbeitnow.nl/login"))).toBe(NL);
    expect(await resolveEmployerApplyUrl(NL, async () => redirect(302, "/login"))).toBe(NL);
    expect(await resolveEmployerApplyUrl(NL, async () => redirect(302, "mailto:jobs@example.com"))).toBe(NL);
  });

  it("keeps the original URL when the request throws", async () => {
    expect(await resolveEmployerApplyUrl(NL, async () => { throw new Error("timeout"); })).toBe(NL);
  });
});

describe("classifyFormUrl on aggregator pages", () => {
  it("marks every unresolved Arbeitnow country site unsupported, not generic", () => {
    expect(classifyFormUrl(NL).supported).toBe(false);
    expect(classifyFormUrl("https://www.arbeitnow.co.uk/jobs/companies/affirm/x-1").supported).toBe(false);
  });
  it("marks Himalayas pages unsupported", () => {
    expect(classifyFormUrl("https://himalayas.app/companies/acme/jobs/ml-engineer").supported).toBe(false);
  });
  it("classifies a resolved employer link by its own platform", () => {
    expect(classifyFormUrl(EMPLOYER)).toEqual({ supported: true, platform: "recruitee" });
  });
});

describe("Himalayas and Jobicy", () => {
  const HI = "https://himalayas.app/companies/acme/jobs/backend-engineer?utm_source=api";
  it("tries the /apply redirect for Himalayas, keeping the query after the path", async () => {
    const fetchImpl = vi.fn(async () => redirect(302, EMPLOYER));
    expect(await resolveEmployerApplyUrl(HI, fetchImpl)).toBe(EMPLOYER);
    expect(fetchImpl).toHaveBeenCalledWith("https://himalayas.app/companies/acme/jobs/backend-engineer/apply?utm_source=api", expect.objectContaining({ redirect: "manual" }));
  });
  it("keeps the Himalayas URL on the Cloudflare 403 seen from the VPS and a laptop", async () => {
    expect(await resolveEmployerApplyUrl(HI, async () => new Response("challenge", { status: 403 }))).toBe(HI);
  });
  it("keeps the URL when the redirect points back at Himalayas", async () => {
    expect(await resolveEmployerApplyUrl(HI, async () => redirect(302, "https://himalayas.app/login"))).toBe(HI);
  });
  it("never requests Jobicy: it has no employer link to follow", async () => {
    const fetchImpl = vi.fn();
    const url = "https://jobicy.com/jobs/163127-applied-ai-engineer";
    expect(await resolveEmployerApplyUrl(url, fetchImpl)).toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("names rows still on either host as having no employer link", () => {
    expect(hasNoEmployerLink(HI)).toBe(true);
    expect(hasNoEmployerLink("https://jobicy.com/jobs/1-x")).toBe(true);
    expect(hasNoEmployerLink(EMPLOYER)).toBe(false);
    expect(hasNoEmployerLink(null)).toBe(false);
    expect(hasNoEmployerLink("https://nothimalayas.app/x")).toBe(false);
  });
});

describe("dropNoEmployerLink", () => {
  it("drops only hand-off rows still on Himalayas or Jobicy and counts them", () => {
    const rows = [
      { apply_lane: "hand_off", url: "https://himalayas.app/companies/a/jobs/b" },
      { apply_lane: "needs_you", url: "https://jobicy.com/jobs/1-x" },
      { apply_lane: "hand_off", url: "https://jobicy.com/jobs/2-y" },
      { apply_lane: "hand_off", url: EMPLOYER },
    ];
    const out = dropNoEmployerLink(rows);
    expect(out.noLink).toBe(2);
    expect(out.rows.map((r) => r.url)).toEqual(["https://jobicy.com/jobs/1-x", EMPLOYER]);
  });
});
