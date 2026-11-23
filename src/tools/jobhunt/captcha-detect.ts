/**
 * Which bot-check vendor is on a form
 * ===================================
 * reCAPTCHA Enterprise (Greenhouse hosted boards, invisible) and Cloudflare Turnstile (Workable) drew no captcha
 * class or field name the per-field check could see, so those rows routed to `auto` and failed at Submit (#1322).
 * The classifier is pure (tests/unit/jobhunt/captcha-detect.test.ts); the probe reads the LIVE DOM, because
 * SmartRecruiters and others inject the loader by script after the page loads.
 *
 * Plain reCAPTCHA v2/v3 is not listed on purpose: it shows no challenge on most forms and a submit passes
 * (tests/unit/jobhunt/recruitee-hcaptcha.test.ts pins that).
 */

import type { Page } from "playwright";
import { dismissCookieBanner } from "./cookie-banner.js";

export type CaptchaVendor = "recaptcha-enterprise" | "turnstile" | "hcaptcha" | "friendly-captcha";

/** The word the lane reason and the hand-off panel show. Every label holds "captcha" or "Turnstile" (the Mac lease filter). */
export const VENDOR_LABEL: Readonly<Record<CaptchaVendor, string>> = {
  "recaptcha-enterprise": "reCAPTCHA Enterprise",
  turnstile: "Cloudflare Turnstile",
  hcaptcha: "hCaptcha",
  "friendly-captcha": "Friendly Captcha",
};

const VENDOR_PATTERNS: readonly (readonly [CaptchaVendor, RegExp])[] = [
  ["recaptcha-enterprise", /recaptcha\/enterprise/i],
  ["turnstile", /challenges\.cloudflare\.com|turnstile/i],
  ["hcaptcha", /hcaptcha|h-captcha/i],
  ["friendly-captcha", /frc-captcha|friendlycaptcha|friendly-challenge/i],
];

/** The vendor a script src, iframe src or widget class names, or null. */
export function captchaVendorOf(ref: string): CaptchaVendor | null {
  for (const [vendor, re] of VENDOR_PATTERNS) if (re.test(ref)) return vendor;
  return null;
}

export interface CaptchaDomFacts {
  /** Every script src, iframe src, and widget class / id found in the live DOM. */
  readonly refs: readonly string[];
  /** `window.grecaptcha.enterprise` exists: the Enterprise loader ran even when its tag is gone. */
  readonly enterpriseGlobal: boolean;
}

export function detectCaptchaVendor(facts: CaptchaDomFacts): CaptchaVendor | null {
  for (const ref of facts.refs) {
    const v = captchaVendorOf(ref);
    if (v) return v;
  }
  return facts.enterpriseGlobal ? "recaptcha-enterprise" : null;
}

/** Read the live DOM of the page and name the bot-check vendor on it, or null. */
export async function probeCaptchaVendor(page: Page): Promise<CaptchaVendor | null> {
  // A banner can hold the vendor's loader back until the visitor chooses (Nebius, Turnstile): decline it first.
  await dismissCookieBanner(page);
  const first = await readOnce(page);
  if (first) return first;
  // A loader injected by script lands moments after load: look once more before calling the form clean.
  await page.waitForTimeout(LATE_INJECT_MS).catch(() => undefined); // allow-failopen: a closed page just skips the wait.
  return readOnce(page);
}

const LATE_INJECT_MS = 400;

/** Runs in the page. A string, not a function: this project's TS config has no DOM types. */
const READ_DOM = `(() => {
  const refs = [];
  document.querySelectorAll("script[src], iframe[src]").forEach((e) => refs.push(e.getAttribute("src") || ""));
  document.querySelectorAll('[class*="turnstile" i], [class*="captcha" i], [data-sitekey], [id*="captcha" i]')
    .forEach((e) => refs.push((e.getAttribute("class") || "") + " " + e.id));
  return { refs, enterpriseGlobal: !!(window.grecaptcha && window.grecaptcha.enterprise) };
})()`;

async function readOnce(page: Page): Promise<CaptchaVendor | null> {
  // allow-failopen: a failed probe (navigation mid-read) leaves the per-field result, which is what we had before.
  const facts = (await page.evaluate(READ_DOM).catch(() => null)) as CaptchaDomFacts | null;
  return facts ? detectCaptchaVendor(facts) : null;
}

/** A visible challenge widget, its loader, or its token field (Recruitee). Invisible plain reCAPTCHA (size=invisible) is left out: it shows no challenge. */
export const CAPTCHA_WIDGET = [
  'iframe[title*="captcha" i]:not([src*="size=invisible"])',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="turnstile" i]',
  "script#hcaptcha-api-script-id",
  'script[src*="hcaptcha" i]',
  '[id^="input-captchaToken"]',
  'input[name="captchaToken"]',
].join(", ");
