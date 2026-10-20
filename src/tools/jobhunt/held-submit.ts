/**
 * Held submit: the emailed confirm-you-are-human code step (ADR-018 amendment 2026-10-18).
 * Greenhouse answers the Submit click with a code field (the code is emailed to the applicant) and keeps
 * Submit greyed until it is typed. This module keeps that one browser page open for up to ten minutes,
 * keyed by application row, so the founder can type the code on the Mini App page.
 * The bot never reads email: the code only arrives through enterEmailCode, typed by the founder.
 * The confirmation check lives here so the first click and the click after the code run the same check.
 * Markup is a HYPOTHESIS (no saved Greenhouse HTML in the repo): prompt text + empty code input(s) + greyed Submit.
 */

import type { Locator, Page } from "playwright";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "jobhunt:held-submit" });

export const SUBMIT_CONFIRM_TIMEOUT_MS = 12_000;
export const CODE_HOLD_MS = 10 * 60_000;
export const CODE_PATTERN = /^[A-Za-z0-9]{4,12}$/;
const CODE_POLL_MS = 400;
// Ashby's banner says "Thanks for throwing your hat in the ring" (Bureau, 2026-10-17), so "thanks for" counts too.
const CONFIRM_TEXT = /thank you|thanks for (applying|your application|throwing your hat|submitting)|application (received|submitted)|we('| ha)ve received|successfully submitted|bedankt voor je sollicitatie/i;

/** Appended to unconfirmed evidence when the page runs a hidden bot check; the answer page keys its hand-off on it. */
export const BOT_CHECK_EVIDENCE =
  "This form runs a hidden bot check (reCAPTCHA) that can silently refuse an automated browser, so it most likely was not sent: submit it yourself from the job link.";

/** Unconfirmed evidence when the click opened a visible CAPTCHA (EMA and AppZen, 2026-10-17); the bot never solves one. */
export const VISIBLE_CAPTCHA_EVIDENCE =
  "The click opened a visible bot check, a CAPTCHA challenge (hCaptcha), that the bot does not solve, so it was not sent: submit it yourself from the job link.";

/** True when unconfirmed evidence says a bot check (hidden or visible) most likely refused the bot's click. */
export function namesHiddenBotCheck(evidence: string | undefined): boolean {
  return evidence !== undefined && /(hidden|visible) bot check/i.test(evidence);
}

export interface HeldClock {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}
const REAL_CLOCK: HeldClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
let clock: HeldClock = REAL_CLOCK;
export function setHeldClockForTests(override?: HeldClock): void {
  clock = override ?? REAL_CLOCK;
}

/** Evaluated in the page (a string, so no DOM typings are needed). Marks the code inputs with data-fo-code-input. */
/** strict: Submit must be greyed and the input empty (the first look). Relaxed: after a code was typed (a wrong one keeps the step). */
const detectScript = (strict: boolean): string => `(() => {
  const STRICT = ${strict};
  const PROMPT = /(verification|security) code|code (was )?sent to|enter the (\\d+[- ]character )?code/i;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  for (const old of document.querySelectorAll("[data-fo-code-input]")) old.removeAttribute("data-fo-code-input");
  const text = (document.body && document.body.innerText) || "";
  if (!PROMPT.test(text)) return { found: false, inputs: 0 };
  const submits = Array.from(document.querySelectorAll("button, input[type=submit]")).filter(
    (b) => vis(b) && (b.type === "submit" || /submit|send application|apply/i.test(b.textContent || "")),
  );
  const greyed = submits.length > 0 && submits.every((b) => b.disabled || b.getAttribute("aria-disabled") === "true");
  if (STRICT && !greyed) return { found: false, inputs: 0 };
  const fields = Array.from(document.querySelectorAll("input")).filter(
    (i) => vis(i) && !i.disabled && !i.readOnly && ["", "text", "tel", "number"].includes(i.type) && (!STRICT || i.value === ""),
  );
  const boxes = fields.filter((i) => i.maxLength === 1);
  const hint = /code|otp|security|verif|one-time/i;
  const single = fields.filter(
    (i) => (i.maxLength >= 4 && i.maxLength <= 12) || hint.test([i.id, i.name, i.placeholder, i.getAttribute("aria-label"), i.autocomplete].join(" ")),
  );
  const chosen = boxes.length >= 4 ? boxes : single.slice(0, 1);
  chosen.forEach((el, n) => el.setAttribute("data-fo-code-input", String(n)));
  return { found: chosen.length > 0, inputs: chosen.length };
})()`;

interface Detection {
  readonly found: boolean;
  readonly inputs: number;
}

async function detect(page: Page, strict = true): Promise<Detection> {
  return (await page.evaluate(detectScript(strict))) as Detection;
}

/** True when the page shows the emailed-code step: prompt text, an empty code input (or boxes) and a greyed Submit. */
export async function detectEmailCodePrompt(page: Page, strict = true): Promise<boolean> {
  return (await detect(page, strict)).found;
}

async function visibleAlertText(page: Page): Promise<string> {
  const text = await page
    .locator("[role=alert]:visible, .field-error:visible, .error-message:visible")
    .first()
    .innerText({ timeout: 1_000 })
    // allow-failopen: no visible error element means there is no extra detail to quote.
    .catch(() => "");
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export type SubmitOutcome =
  | { readonly kind: "confirmed"; readonly evidence: string }
  | { readonly kind: "code-needed"; readonly evidence: string }
  | { readonly kind: "unconfirmed"; readonly evidence: string };

/** Resolves only when the code prompt shows up; otherwise it never settles (the race is decided by the others). */
function watchForCodePrompt(page: Page, stop: { done: boolean }): Promise<"code"> {
  return new Promise<"code">((resolve) => {
    const deadline = clock.now() + SUBMIT_CONFIRM_TIMEOUT_MS;
    const tick = async (): Promise<void> => {
      if (stop.done || clock.now() > deadline) return;
      // allow-failopen: a failed probe (page navigating or closed) counts as no prompt yet.
      const found = await detectEmailCodePrompt(page).catch(() => false);
      if (found) resolve("code");
      else setTimeout(() => void tick(), CODE_POLL_MS);
    };
    void tick();
  });
}

/** Evaluated in the page: thank-you text is visible and no Submit control is left on screen. */
const thankYouScript = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const text = (document.body && document.body.innerText) || "";
  if (!${CONFIRM_TEXT}.test(text)) return false;
  return !Array.from(document.querySelectorAll("button, input[type=submit]")).some(
    (b) => vis(b) && (b.getAttribute("type") === "submit" || /submit|send application/i.test(b.textContent || b.value || "")),
  );
})()`;

/**
 * Resolves when the thank-you shows with the form gone; rejects at the deadline.
 * Text alone is not enough: Matillion's Lever form says "Thank you for your interest…" above its Submit
 * button, which marked an unsent application applied (2026-10-17).
 */
function watchForThankYou(page: Page, stop: { done: boolean }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = clock.now() + SUBMIT_CONFIRM_TIMEOUT_MS;
    const tick = async (): Promise<void> => {
      if (stop.done) return;
      if (clock.now() > deadline) return reject(new Error("no thank-you"));
      // allow-failopen: a failed probe (page navigating or closed) counts as no thank-you yet.
      const seen = (await page.evaluate(thankYouScript).catch(() => false)) as boolean;
      if (seen) resolve();
      else setTimeout(() => void tick(), CODE_POLL_MS);
    };
    void tick();
  });
}

/** After a Submit click: confirmed (URL change or thank-you text), code step shown, or unconfirmed with the reason. */
export async function awaitSubmitOutcome(
  page: Page,
  urlBefore: string,
  dialog: { message: string | null },
  opts: { readonly watchForCode: boolean; readonly afterCode?: boolean },
): Promise<SubmitOutcome> {
  const stop = { done: false };
  const confirmed = Promise.race([
    page.waitForURL((u) => u.toString() !== urlBefore, { timeout: SUBMIT_CONFIRM_TIMEOUT_MS }),
    watchForThankYou(page, stop),
  ]).then(() => "confirmed" as const);
  const racers: Promise<"confirmed" | "code">[] = [confirmed];
  if (opts.watchForCode) racers.push(watchForCodePrompt(page, stop));
  try {
    const won = await Promise.race(racers);
    if (won === "code") {
      return { kind: "code-needed", evidence: "The form is asking for the confirmation code that was emailed to the applicant." };
    }
    return { kind: "confirmed", evidence: `Confirmed: page navigated or displayed submission confirmation (from ${urlBefore} to ${page.url()})` };
  } catch {
    // allow-failopen: the confirmation race timed out; the checks below explain why, and none of them is fatal.
    const stillAsking = await detectEmailCodePrompt(page, !opts.afterCode).catch(() => false);
    if (stillAsking) {
      const why = await visibleAlertText(page);
      return { kind: "code-needed", evidence: why ? `The form still asks for the code: ${why}` : "The form still asks for the code." };
    }
    if (dialog.message) return { kind: "unconfirmed", evidence: `Form showed an alert dialog after click: "${dialog.message}"` };
    const challenge = await page
      .locator("iframe[src*='hcaptcha']:visible, iframe[title*='hCaptcha' i]:visible")
      .count()
      // allow-failopen: a failed probe only drops the CAPTCHA reason; the outcome stays unconfirmed.
      .catch(() => 0);
    if (challenge > 0) return { kind: "unconfirmed", evidence: VISIBLE_CAPTCHA_EVIDENCE };
    const errors = await page
      .locator("[aria-invalid=true]:visible, [role=alert]:visible, .field-error:visible, .error-message:visible")
      .count()
      // allow-failopen: 0 means no visible error element was detected.
      .catch(() => 0);
    if (errors > 0) return { kind: "unconfirmed", evidence: `Form displayed ${errors} validation error element(s) after clicking submit` };
    const evidence = "Clicked submit; no error appeared, but no confirmation banner or URL change was observed within 12s - check screenshot to verify";
    const botCheck = await page
      .locator(".grecaptcha-badge, iframe[src*='recaptcha'], script[src*='recaptcha']")
      .count()
      // allow-failopen: a failed probe only drops the hint; the outcome stays unconfirmed.
      .catch(() => 0);
    if (botCheck === 0) return { kind: "unconfirmed", evidence };
    // The bot must not try to get past the check; the founder submits from his own browser instead.
    return { kind: "unconfirmed", evidence: `${evidence}. ${BOT_CHECK_EVIDENCE}` };
  } finally {
    stop.done = true;
  }
}

// -- the held page ------------------------------------------------------------------------------

export interface HoldInput {
  readonly page: Page;
  readonly browser: { close(): Promise<void> };
  readonly dialog: { message: string | null };
  /** Finds the Submit control again after the code is typed (the runner's own finder). */
  readonly findSubmit: () => Promise<Locator | null>;
}

interface Held extends HoldInput {
  readonly expiresAt: number;
  timer: unknown;
  busy: boolean;
  onExpire?: () => void | Promise<void>;
}

const held = new Map<string, Held>();

async function closeQuietly(h: Held): Promise<void> {
  // allow-failopen: the browser may already be gone; closing is cleanup only.
  await h.browser.close().catch(() => undefined);
}

/** Close and forget a held page. Safe when nothing is held. Returns true when a page was closed. */
export async function releaseHeld(rowId: string): Promise<boolean> {
  const h = held.get(rowId);
  if (!h) return false;
  held.delete(rowId);
  clock.clearTimer(h.timer);
  await closeQuietly(h);
  return true;
}

/** Keep this page open for CODE_HOLD_MS. A page already held for the row is closed first. */
export function holdForEmailCode(rowId: string, input: HoldInput): void {
  if (held.has(rowId)) void releaseHeld(rowId);
  const entry: Held = { ...input, expiresAt: clock.now() + CODE_HOLD_MS, timer: undefined, busy: false };
  entry.timer = clock.setTimer(() => void expire(rowId, entry), CODE_HOLD_MS);
  held.set(rowId, entry);
}

async function expire(rowId: string, entry: Held): Promise<void> {
  if (held.get(rowId) !== entry || entry.busy) return;
  held.delete(rowId);
  await closeQuietly(entry);
  log.info({ rowId }, "held submit: no code within the window, browser closed");
  try {
    await entry.onExpire?.();
  } catch (err) {
    // allow-failopen: the browser is closed either way; a failed notice is logged.
    log.warn({ rowId, err: (err as Error).message }, "held submit: expiry notice failed");
  }
}

/** Called when the window runs out without a confirmed send, so the caller can tell the founder. */
export function onHeldExpired(rowId: string, fn: () => void | Promise<void>): void {
  const h = held.get(rowId);
  if (h) h.onExpire = fn;
}

/** Seconds left to type the code, or null when nothing is held for the row. */
export function heldCodeInfo(rowId: string, nowMs: number = clock.now()): { readonly secondsLeft: number } | null {
  const h = held.get(rowId);
  return h ? { secondsLeft: Math.max(0, Math.ceil((h.expiresAt - nowMs) / 1000)) } : null;
}

export function heldRowIdsForTests(): string[] {
  return [...held.keys()];
}

export type CodeEntryResult =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "confirmed" | "code-needed" | "unconfirmed"; readonly evidence: string; readonly screenshotPng: Buffer };

async function shot(page: Page): Promise<Buffer> {
  // allow-failopen: the proof screenshot is best effort; the outcome is reported without it.
  return page.screenshot({ fullPage: true, type: "png" }).catch(() => Buffer.alloc(0));
}

/** Types into the marked inputs. Returns a problem string, or null when typed. */
async function typeCode(page: Page, code: string): Promise<string | null> {
  const found = await detect(page, false);
  if (!found.found) return "the code field is no longer on the page";
  const inputs = page.locator("[data-fo-code-input]");
  for (let i = 0; i < found.inputs; i++) await inputs.nth(i).fill("", { timeout: 5_000 });
  if (found.inputs > 1) {
    if (code.length !== found.inputs) return "length";
    for (let i = 0; i < found.inputs; i++) await inputs.nth(i).pressSequentially(code[i]!, { timeout: 5_000 });
  } else {
    await inputs.first().pressSequentially(code, { delay: 20, timeout: 5_000 });
  }
  return null;
}

/** Type the founder's code, click Submit again and run the confirmation check. Confirmed or unconfirmed ends the hold. */
export async function enterEmailCode(rowId: string, code: string): Promise<CodeEntryResult> {
  const h = held.get(rowId);
  if (!h) return { kind: "none" };
  if (!CODE_PATTERN.test(code)) return { kind: "invalid", reason: "The code is 4 to 12 letters and digits." };
  if (h.busy) return { kind: "invalid", reason: "A code is already being entered." };
  h.busy = true;
  try {
    const problem = await typeCode(h.page, code);
    if (problem === "length") return { kind: "invalid", reason: "That code does not fit the form (it has one box per character)." };
    if (problem) return await finish(rowId, h, "unconfirmed", `Could not enter the code: ${problem}.`);
    const button = await h.findSubmit();
    if (!button) return await finish(rowId, h, "unconfirmed", "Could not find the Submit button after typing the code.");
    const urlBefore = h.page.url();
    h.dialog.message = null;
    await button.click({ timeout: 10_000 });
    const outcome = await awaitSubmitOutcome(h.page, urlBefore, h.dialog, { watchForCode: false, afterCode: true });
    if (outcome.kind === "code-needed") return { kind: "code-needed", evidence: outcome.evidence, screenshotPng: await shot(h.page) };
    return await finish(rowId, h, outcome.kind, outcome.evidence);
  } catch (err) {
    return await finish(rowId, h, "unconfirmed", `Entering the code failed: ${(err as Error).message}`);
  } finally {
    h.busy = false;
  }
}

async function finish(rowId: string, h: Held, kind: "confirmed" | "unconfirmed", evidence: string): Promise<CodeEntryResult> {
  const screenshotPng = await shot(h.page);
  if (held.get(rowId) === h) await releaseHeld(rowId);
  return { kind, evidence, screenshotPng };
}
