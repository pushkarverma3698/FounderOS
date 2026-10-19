/**
 * Arbeitnow rows store Arbeitnow's own page, which the VPS browser cannot open (Cloudflare) and which
 * has no application form. Its `/apply` link answers with a plain 302 to the employer's form; these
 * tests pin that resolution and every way it must fall back to the original URL.
 */

import { describe, it, expect, vi } from "vitest";
import { isArbeitnowUrl, resolveEmployerApplyUrl } from "../../../src/tools/jobhunt/aggregator-apply-url.js";
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
