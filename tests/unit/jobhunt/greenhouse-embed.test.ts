/**
 * Company careers pages that embed a Greenhouse board (`?gh_jid=`) render no form on the company's own domain, so the
 * form runner reported "no fillable form fields". The hosted board has the form: job-boards.greenhouse.io/<token>/jobs/<id>.
 * Company names below are real registry rows (docs/strategy/data/free-ats-boards.csv).
 */
import { describe, it, expect } from "vitest";
import { greenhouseHostedUrl } from "../../../src/tools/jobhunt/greenhouse-embed.js";
import { resolveFormTargetUrl, classifyFormTarget } from "../../../src/tools/jobhunt/form-platform.js";

describe("greenhouseHostedUrl", () => {
  it("rewrites an embedded posting to the hosted form when the company is a known Greenhouse board", () => {
    expect(greenhouseHostedUrl("https://www.appviewx.com/careers/open-positions/?gh_jid=4567890", "AppViewX")).toBe(
      "https://job-boards.greenhouse.io/appviewx/jobs/4567890",
    );
  });

  it("matches the company name case-insensitively and ignoring punctuation", () => {
    expect(greenhouseHostedUrl("https://schubergphilis.com/en/careers/job?gh_jid=123", "schuberg philis")).toBe(
      "https://job-boards.greenhouse.io/schubergphilis/jobs/123",
    );
  });

  it("leaves the URL alone without a gh_jid", () => {
    expect(greenhouseHostedUrl("https://www.appviewx.com/careers/", "AppViewX")).toBeNull();
  });

  it("leaves the URL alone when gh_jid is not numeric", () => {
    expect(greenhouseHostedUrl("https://www.appviewx.com/careers/?gh_jid=abc", "AppViewX")).toBeNull();
  });

  it("leaves the URL alone when the company is not a known Greenhouse board", () => {
    expect(greenhouseHostedUrl("https://example.invalid/jobs?gh_jid=99", "Nonexistent Co 12345")).toBeNull();
  });

  it("ignores a same-named board on another ATS", () => {
    // Registry has Stagecoach on workday only.
    expect(greenhouseHostedUrl("https://stagecoach.example/jobs?gh_jid=5", "Stagecoach")).toBeNull();
  });

  it("does nothing to a URL that is already a Greenhouse board URL", () => {
    expect(greenhouseHostedUrl("https://job-boards.greenhouse.io/appviewx/jobs/1?gh_jid=1", "AppViewX")).toBeNull();
  });
});

describe("resolveFormTargetUrl with an embedded Greenhouse posting", () => {
  const url = "https://www.appviewx.com/careers/open-positions/?gh_jid=4567890";

  it("opens the hosted form instead of the company page", () => {
    expect(resolveFormTargetUrl(url, "AppViewX", "generic")).toBe(
      "https://job-boards.greenhouse.io/appviewx/jobs/4567890",
    );
  });

  it("keeps the company page when the token is unknown", () => {
    expect(resolveFormTargetUrl(url, "Nonexistent Co 12345", "generic")).toBe(url);
  });

  it("classifies the hosted form as greenhouse, not generic, and hands the runner its URL", () => {
    expect(classifyFormTarget(url, "AppViewX")).toEqual({
      supported: true,
      platform: "greenhouse",
      targetUrl: "https://job-boards.greenhouse.io/appviewx/jobs/4567890",
    });
    expect(classifyFormTarget(url, "Nonexistent Co 12345")).toEqual({ supported: true, platform: "generic", targetUrl: url });
  });
});
