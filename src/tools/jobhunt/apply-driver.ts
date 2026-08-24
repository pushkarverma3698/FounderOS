/**
 * FounderOS — acting on a real application form
 * =================================================
 * The write half of `apply_headless`'s Playwright driver: filling a scraped
 * `FillAction[]` in, screenshotting the result, and — after the founder has
 * approved — finding and clicking the real submit control. Reading the form
 * (`scrapeFormFields`, `detectApplyAts`) lives in apply-scrape.ts.
 *
 * Reuses the `chromium` dependency `cv-renderer.ts` already runs on the VPS to
 * render every tailored CV. No new infrastructure.
 *
 * NOT UNIT-TESTED AT THIS LAYER, DELIBERATELY — see apply-scrape.ts's header
 * for why. `apply-fill.ts`'s decision core is what's tested.
 *
 * SUBMIT-BUTTON DETECTION IS A HEURISTIC, STATED HONESTLY. None of the five
 * platforms' real submit buttons were captured with certainty during the
 * 2026-08-24 field survey — only the form FIELDS were. `findSubmitButton`
 * looks for the conventional `button[type="submit"]` or clear submit-labelled
 * text, and `verifySubmitted` never reports success without an observed
 * signal (URL change or confirmation text) — a heuristic that clicks the wrong
 * thing must surface as "could not confirm," never as a false "done" (rule
 * #24: evidence over assertion). The founder's own approval tap, required
 * before any click at all, is the real safety boundary; this is the second one.
 */

import type { Page } from "playwright";
import { chromium } from "playwright";
import { childLogger } from "../../infra/logger.js";
import type { FillAction } from "./apply-fill.js";
import { detectApplyAts, scrapeFormFields, type SupportedAts } from "./apply-scrape.js";

export { detectApplyAts, scrapeFormFields, type SupportedAts };

const log = childLogger({ module: "jobhunt:apply-driver" });

const NAV_BUTTON_EXCLUSIONS = ["header-tab-apply-button", "apply-button-nav"];

/**
 * Type a value so it survives a controlled-input form, not just so it
 * appears in the DOM for a moment.
 *
 * `.fill()` alone is not enough — verified live on Greenhouse (Workwize),
 * 2026-08-24: `.fill("TESTVALUE")` reported success and `inputValue()`
 * confirmed the write immediately, then the field silently reverted to ""
 * within 700ms with no error anywhere. Greenhouse's form holds its own React
 * state as the source of truth; `.fill()` sets the DOM value directly, and
 * whatever debounced sync reconciles the DOM back to React's (still empty)
 * state wins. `.pressSequentially()` — real per-keystroke events — does not
 * have this problem, confirmed on the same field in the same session.
 *
 * `.fill()` stays the FIRST attempt because it is faster and correct on every
 * other platform tested (Recruitee, Ashby, Workable). The read-back after it
 * is what catches the Greenhouse case without hard-coding a per-platform
 * branch: if the value did not stick, retry with real keystrokes; if it still
 * did not stick, say so truthfully rather than claim success.
 *
 * `CONTROLLED_INPUT_SETTLE_MS`: how long the debounced state-sync takes to
 * overwrite a `.fill()` that never reached React. Measured live: the revert
 * lands "within 700ms", not synchronously — a read-back checked immediately
 * after `.fill()` still saw the value and reported success right before it
 * vanished. This wait is what makes the check honest rather than a race
 * against the same debounce it exists to catch.
 */
const CONTROLLED_INPUT_SETTLE_MS = 800;

async function typeValue(page: Page, selector: string, value: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  await locator.fill(value, { timeout: 5000 });
  await page.waitForTimeout(CONTROLLED_INPUT_SETTLE_MS);
  // allow-failopen: an unreadable value reads as "" — never equals `value`, so this is a plain miss, not a masked crash.
  if ((await locator.inputValue().catch(() => "")) === value) return true;

  // allow-failopen: clearing before the retry is best-effort — pressSequentially still runs and the read-back below is the real check.
  await locator.fill("", { timeout: 5000 }).catch(() => undefined);
  await locator.pressSequentially(value, { delay: 20, timeout: 15_000 });
  await page.waitForTimeout(CONTROLLED_INPUT_SETTLE_MS);
  // allow-failopen: same as the first read-back — an error here just means "did not verify," which the caller already treats as failure.
  return (await locator.inputValue().catch(() => "")) === value;
}

export interface FillOutcome {
  readonly selector: string;
  readonly kind: FillAction["kind"];
  readonly succeeded: boolean;
}

/**
 * Execute a fill plan. `ask` actions are skipped — leaving that field exactly
 * as the form rendered it, for the founder to complete himself.
 *
 * RETURNS WHAT ACTUALLY HAPPENED, not what was attempted. Before this, a
 * silently-reverted Greenhouse field (see `typeValue`) and a genuinely filled
 * one were indistinguishable to every caller — `summarisePlan` counted a
 * planned `value` action as "filled" regardless of whether the browser still
 * held it a moment later, so the founder's screenshot caption could read
 * "6/18 filled" while some of those six were actually blank. Every result
 * here is read back from the live DOM after the attempt, not inferred from
 * whether the Playwright call itself threw.
 */
export async function executeFillPlan(page: Page, actions: readonly FillAction[]): Promise<FillOutcome[]> {
  const outcomes: FillOutcome[] = [];
  for (const action of actions) {
    if (action.kind === "ask") continue; // nothing to execute or verify

    try {
      let succeeded: boolean;
      if (action.kind === "value") {
        succeeded = await typeValue(page, action.selector, action.value);
      } else if (action.kind === "file") {
        // setInputFiles throws on a missing path rather than silently no-op'ing,
        // so reaching this line without a throw IS the verification.
        await page.locator(action.selector).first().setInputFiles(action.path, { timeout: 10_000 });
        succeeded = true;
      } else {
        succeeded = await clickOption(page, action.selector, action.option);
      }
      outcomes.push({ selector: action.selector, kind: action.kind, succeeded });
      if (!succeeded) {
        log.warn({ selector: action.selector, kind: action.kind }, "Fill action ran but did not verify — field left as-is");
      }
    } catch (err) {
      log.warn({ selector: action.selector, kind: action.kind, err: (err as Error).message }, "Fill action failed — field left as-is");
      outcomes.push({ selector: action.selector, kind: action.kind, succeeded: false });
    }
  }
  return outcomes;
}

/**
 * Click the specific radio/checkbox within a group whose text matches
 * `optionText`, and confirm it is actually checked afterward.
 *
 * Returns false — never throws — when the option cannot be found or the
 * click did not result in a checked input, so the caller can report an
 * accurate outcome instead of assuming a click that ran means a box that
 * ticked.
 */
async function clickOption(page: Page, groupSelector: string, optionText: string): Promise<boolean> {
  const inputs = page.locator(groupSelector);
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    // Same ancestor-climb as scrapeFormFields's optionText — NOT
    // nextElementSibling, which is an <svg> icon on Greenhouse and returns
    // empty on every platform tested live. Must match the scrape exactly, or
    // a correctly-scraped option can never be found again to click it.
    const text = await input
      .evaluate((el) => {
        let n: HTMLElement | null = (el as HTMLElement).parentElement;
        for (let i = 0; i < 5 && n; i++) {
          const t = n.textContent?.trim() ?? "";
          if (t.length > 0 && t.length < 300) return t;
          n = n.parentElement;
        }
        return "";
      })
      // allow-failopen: unreadable text just never matches optionText — the loop tries the next option.
      .catch(() => "");
    if (text === optionText) {
      // `.click()` is a deliberate fallback for a styled-div-wrapped input where `.check()`'s actionability check fails.
      // allow-failopen: not a swallow of a real failure — a genuine click failure still throws from THIS line.
      await input.check({ timeout: 5000 }).catch(() => input.click({ timeout: 5000 }));
      // allow-failopen: an unreadable checked-state reads as false — the caller reports it as "did not verify," which is accurate.
      return input.isChecked().catch(() => false);
    }
  }
  log.warn({ groupSelector, optionText }, "Could not locate the chosen option's input — field left as-is");
  return false;
}

/** Screenshot the filled form, full page, for the founder to review before approving. */
export async function screenshotForm(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: true, type: "png" });
}

/**
 * Find the real submit control. A HEURISTIC — see the module header.
 *
 * Deliberately excludes the "Apply" tab/nav buttons some platforms (Recruitee)
 * use to reveal the form in the first place; those were already clicked during
 * navigation and clicking them again does nothing useful.
 */
export async function findSubmitButton(page: Page) {
  const candidates = page.locator(
    'form button[type="submit"], form input[type="submit"], button[type="submit"]',
  );
  const count = await candidates.count();
  for (let i = count - 1; i >= 0; i--) {
    const btn = candidates.nth(i);
    // allow-failopen: no data-testid just means this candidate can't match the nav-button exclusion list — it proceeds.
    const testId = await btn.getAttribute("data-testid").catch(() => null);
    if (testId && NAV_BUTTON_EXCLUSIONS.includes(testId)) continue;
    // allow-failopen: a visibility check that itself errors is treated as "not visible," never as "found."
    if (await btn.isVisible().catch(() => false)) return btn;
  }
  // Fallback: a button whose own text says so, last on the page.
  const byText = page.locator('button:visible, a[role="button"]:visible').filter({ hasText: /^(submit|apply|send application|submit application)$/i });
  const textCount = await byText.count();
  if (textCount > 0) return byText.nth(textCount - 1);
  return null;
}

export interface SubmitOutcome {
  readonly clicked: boolean;
  readonly confirmed: boolean;
  readonly evidence: string;
}

/**
 * Click submit and make a bounded, honest attempt to confirm it worked.
 *
 * NEVER REPORTS `confirmed: true` WITHOUT AN OBSERVED SIGNAL — a URL change
 * away from the apply page, or confirmation text appearing. A click with
 * neither is reported as unconfirmed, not as a guess at success (rule #24).
 */
export async function clickSubmitAndVerify(page: Page): Promise<SubmitOutcome> {
  const button = await findSubmitButton(page);
  if (!button) {
    return { clicked: false, confirmed: false, evidence: "no submit control found on the page" };
  }

  const urlBefore = page.url();
  await button.click({ timeout: 10_000 }).catch((err) => {
    throw new Error(`submit click failed: ${(err as Error).message}`);
  });

  const CONFIRM_TIMEOUT_MS = 15_000;
  try {
    await Promise.race([
      page.waitForURL((url) => url.toString() !== urlBefore, { timeout: CONFIRM_TIMEOUT_MS }),
      page
        .getByText(/thank you|application (received|submitted)|we('| ha)ve received|successfully submitted/i)
        .first()
        .waitFor({ state: "visible", timeout: CONFIRM_TIMEOUT_MS }),
    ]);
    return { clicked: true, confirmed: true, evidence: `URL or confirmation text changed after submit (was ${urlBefore})` };
  } catch {
    return {
      clicked: true,
      confirmed: false,
      evidence: "clicked submit but no URL change or confirmation text appeared within 15s — verify manually",
    };
  }
}

export interface DriverSession {
  readonly page: Page;
  close(): Promise<void>;
}

/**
 * Reveal the form on platforms that render it into an inert tab panel at
 * page load, rather than landing on it directly.
 *
 * RECRUITEE ONLY, and found the hard way: a first pass at this driver scraped
 * Ockto's posting successfully — real field labels, real selectors — and every
 * fill then failed with "element is not visible", persisting through repeated
 * waits, `networkidle`, and `scrollIntoViewIfNeeded`. The form fields exist in
 * the DOM from first paint; they only become interactive after the page's
 * "Apply" button is clicked. `[data-testid="header-tab-apply-button"]` looked
 * like that control and is NOT it — clicking it changes nothing observable; a
 * second, near-identical button with no testid (matched here by its exact
 * visible text) is the one that actually reveals the form. Confirmed live,
 * 2026-08-24: the field's bounding box goes from `null` to a real
 * `{width:440, height:48}` only after clicking that second button.
 */
async function revealFormIfNeeded(page: Page, ats: SupportedAts): Promise<void> {
  if (ats !== "recruitee") return;

  // `domcontentloaded` (the navigation's own waitUntil) fires before
  // Recruitee's React app finishes hydrating — the reveal button exists in
  // the DOM from server-rendered HTML, but React has not yet attached its own
  // click handler to it. A click that lands in that gap is not lost loudly;
  // the static HTML has no handler to run, so nothing happens and nothing
  // errors. Confirmed live, 2026-08-24: identical code clicking identical
  // text landed on a dead handler under `domcontentloaded` and worked
  // reliably once `networkidle` was reached first. Scoped to this function
  // rather than the page's own navigation `waitUntil`, so Greenhouse/Lever/
  // Ashby/Workable — which land on a working form directly — are not slowed
  // down waiting for network idle they do not need.
  // allow-failopen: a page with a persistent poll/websocket may never go idle; the click attempt below still runs regardless.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);

  // Two elements match the visible text "Apply" on Ockto's posting: the
  // first is a tab-bar toggle (`data-testid="header-tab-apply-button"`) that
  // changes nothing observable when clicked; the second is the actual reveal
  // control. `.first()` picks the wrong one — verified by directly comparing
  // both, live, 2026-08-24. `.last()` rather than a hard-coded index 1: a
  // posting with only one match (no separate tab toggle) still gets the
  // right element, since first and last are then the same node.
  // Some Recruitee postings render the form directly with no reveal button.
  const clicked = await page
    .getByText("Apply", { exact: true })
    .last()
    .click({ timeout: 10_000 })
    .then(() => true)
    // allow-failopen: a missing/failed click leaves the page as it was, and scrapeFormFields still runs against whatever is actually there.
    .catch(() => false);
  if (!clicked) return;

  // The reveal is a CSS transition, not an instant DOM swap — verified live,
  // 2026-08-24: the target field's bounding box is null/zero-width for a
  // measurable interval right after the click and becomes real
  // (width≈440, height≈48) only after it. Waiting for THIS SPECIFIC field to
  // report a non-zero box is more honest than a fixed sleep, which either
  // races a slow transition or wastes time on a fast one.
  await page
    .locator('input[name="candidate.name"]')
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    // allow-failopen: if the form never becomes visible, scrapeFormFields still finds the (still-hidden) fields and every fill honestly reports failed.
    .catch(() => undefined);
}

/** Open a fresh browser + page at `url`, on platform `ats`. Caller MUST call `close()`. */
export async function openApplyPage(url: string, ats: SupportedAts): Promise<DriverSession> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await revealFormIfNeeded(page, ats);
  return {
    page,
    close: async () => {
      await browser.close();
    },
  };
}
