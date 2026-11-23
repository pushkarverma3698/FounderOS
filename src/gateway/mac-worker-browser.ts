/**
 * Mac worker browser: one tab in the founder's own Chrome
 * =======================================================
 * Attaches to a dedicated Chrome (started by scripts/mac-worker/start-chrome.sh with --remote-debugging-port and its
 * own --user-data-dir; Chrome 136+ refuses remote debugging on the default profile) and drives it with the existing
 * form runner pieces: scrape, fill (executeFormPlan), validity checks, awaitSubmitOutcome. The decisions are in
 * mac-worker-loop.ts; this file is the Playwright side of `FormSession`.
 */

import { chromium, type Browser, type Locator, type Page } from "playwright";
import { emptyStarredFields } from "../tools/jobhunt/form-required-guard.js";
import { summariseFormPlan } from "../tools/jobhunt/form-filled.js";
import { checkFormValidity, executeFormPlan } from "../tools/jobhunt/form-runner.js";
import { classifyFormUrl, resolveFormTargetUrl, revealPlatformForm, scrapePageFields } from "../tools/jobhunt/form-scraper.js";
import { awaitSubmitOutcome, type SubmitOutcome } from "../tools/jobhunt/held-submit.js";
import type { FormSession, SubmitResult } from "./mac-worker-loop.js";
import type { MacPacket } from "./mac-worker-packet.js";
import { applyPacketSources, planFromPacket } from "./mac-worker-plan.js";

export async function connectChrome(cdpUrl: string): Promise<Browser> {
  return chromium.connectOverCDP(cdpUrl);
}

/** Evaluated in the page: a bot-check widget a person has to act on is on screen (visible, not the invisible reCAPTCHA badge). */
const CHALLENGE_SCRIPT = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 30 && r.height > 30 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const frames = Array.from(document.querySelectorAll("iframe")).filter((f) => {
    const hint = (f.src || "") + " " + (f.title || "");
    return /hcaptcha|turnstile|recaptcha|captcha|challenge/i.test(hint) && !/size=invisible/i.test(hint);
  });
  if (frames.some(vis)) return true;
  return Array.from(document.querySelectorAll(".cf-turnstile, .h-captcha, .g-recaptcha")).some(
    (el) => vis(el) && el.querySelector("iframe") !== null,
  );
})()`;

export async function challengeShowing(page: Page): Promise<boolean> {
  return (await page.evaluate(CHALLENGE_SCRIPT)) as boolean;
}

async function findSubmit(page: Page): Promise<Locator | null> {
  const inputs = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
  const n = await inputs.count();
  if (n > 0) return inputs.nth(n - 1);
  const byText = page
    .locator('button:visible, a[role="button"]:visible')
    .filter({ hasText: /^(submit|submit application|send application|apply|verstuur|solliciteer)$/i });
  const m = await byText.count();
  return m > 0 ? byText.nth(m - 1) : null;
}

const toResult = (o: SubmitOutcome): SubmitResult => ({ kind: o.kind, evidence: o.evidence });

export async function openMacSession(browser: Browser, packet: MacPacket, cvPath: string): Promise<FormSession> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const dialog: { message: string | null } = { message: null };
  // allow-failopen: dismissing an alert dialog must not crash the worker.
  page.on("dialog", (d) => void (dialog.message = d.message(), d.dismiss().catch(() => undefined)));
  let urlBefore = "";

  const settle = async (afterCode: boolean): Promise<SubmitResult> => {
    const outcome = await awaitSubmitOutcome(page, urlBefore, dialog, { watchForCode: true, afterCode });
    // allow-failopen: a failed probe means no challenge was seen; the outcome stays as awaitSubmitOutcome reported it.
    if (outcome.kind === "unconfirmed" && (await challengeShowing(page).catch(() => false))) {
      return { kind: "challenge", evidence: `${outcome.evidence} A bot check is showing.` };
    }
    return toResult(outcome);
  };

  return {
    async fill() {
      const check = classifyFormUrl(packet.url);
      if (!check.supported) return { ok: false, reason: check.reason };
      await page.goto(resolveFormTargetUrl(packet.url, packet.company, check.platform), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await revealPlatformForm(page, check.platform);
      const fields = await scrapePageFields(page, check.platform);
      if (fields.length === 0) return { ok: false, reason: "no form fields found on the page" };
      const plan = planFromPacket(fields, packet, cvPath);
      const verified = await executeFormPlan(page, plan);
      return { ok: true, summary: applyPacketSources(summariseFormPlan(plan, fields, verified), packet) };
    },
    challengeVisible: () => challengeShowing(page),
    async preSubmitRefusal() {
      const validity = await checkFormValidity(page);
      if (!validity.valid) return `form native validation failed on "${validity.invalidField}"`;
      const empty = await emptyStarredFields(page);
      if (empty.length > 0) return `required fields are empty: ${empty.join("; ")}`;
      return (await findSubmit(page)) ? null : "could not locate the submit button";
    },
    async submit() {
      const button = await findSubmit(page);
      if (!button) return { kind: "unconfirmed", evidence: "Submit button vanished before the click." };
      urlBefore = page.url();
      await button.click({ timeout: 10_000 });
      return settle(false);
    },
    afterChallenge: () => settle(true),
    proof: () => page.screenshot({ fullPage: true, type: "png" }),
    close: () => page.close(),
  };
}
