/**
 * FounderOS — ATS platform detection and form URL resolution (split from form-scraper.ts for the 400-line cap).
 */

import { getApplyUrl } from "./apply-packet.js";

export type FormPlatform =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "recruitee"
  | "smartrecruiters"
  | "personio"
  | "teamtailor"
  | "bamboohr"
  | "generic";

const PLATFORM_HOST_MARKERS: ReadonlyArray<readonly [Exclude<FormPlatform, "generic">, readonly string[]]> = [
  ["greenhouse", ["greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io", "job-boards.eu.greenhouse.io"]],
  ["lever", ["lever.co", "jobs.lever.co", "jobs.eu.lever.co"]],
  ["ashby", ["ashbyhq.com", "jobs.ashbyhq.com"]],
  ["workable", ["workable.com", "apply.workable.com"]],
  ["recruitee", ["recruitee.com"]],
  ["smartrecruiters", ["smartrecruiters.com", "jobs.smartrecruiters.com"]],
  ["personio", ["personio.com", "personio.de"]],
  ["teamtailor", ["teamtailor.com"]],
  ["bamboohr", ["bamboohr.com"]],
];

const UNSUPPORTED_HOST_REASONS: ReadonlyArray<readonly [string, string]> = [
  ["myworkdayjobs.com", "Workday requires per-company account creation and multi-step login"],
  ["jobicy.com", "Jobicy is an aggregator page without an embedded application form"],
  ["arbeitnow.", "Arbeitnow is an aggregator page without an embedded application form"],
  ["himalayas.app", "Himalayas is an aggregator page that blocks automated access; open the job link"],
  ["linkedin.com", "LinkedIn requires an authenticated browser session"],
];

export type PlatformCheck =
  | { readonly supported: true; readonly platform: FormPlatform }
  | { readonly supported: false; readonly reason: string };

/** Classify a job URL into a supported ATS platform or an explicit unsupported reason. */
export function classifyFormUrl(url: string): PlatformCheck {
  const lowered = (url || "").trim().toLowerCase();
  if (!lowered || !/^https?:\/\//.test(lowered)) {
    return { supported: false, reason: "no valid http(s) URL on file for this role" };
  }
  // The HOST, not the whole URL: a resolved employer link carries `utm_source=arbeitnow.nl`.
  const host = lowered.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
  for (const [marker, reason] of UNSUPPORTED_HOST_REASONS) {
    if (host.includes(marker)) return { supported: false, reason };
  }
  for (const [platform, markers] of PLATFORM_HOST_MARKERS) {
    if (markers.some((m) => lowered.includes(m))) {
      return { supported: true, platform };
    }
  }
  return { supported: true, platform: "generic" };
}

/** Resolve the direct URL where the application form is rendered. */
export function resolveFormTargetUrl(url: string, company: string, platform: FormPlatform): string {
  const mapped = getApplyUrl(url, company);
  if (mapped) return mapped;
  if (platform === "ashby") {
    try {
      const u = new URL(url);
      if (!u.pathname.endsWith("/application")) {
        u.pathname = `${u.pathname.replace(/\/$/, "")}/application`;
      }
      return u.toString();
    } catch {
      return url;
    }
  }
  return url;
}
