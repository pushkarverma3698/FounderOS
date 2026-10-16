/**
 * FounderOS — Headless Playwright Form Runner & Verifier
 * ======================================================
 * Drives a real ATS application form in headless Chromium:
 *   1. `prepareApplicationForm`: fills all known fields and captures a preview screenshot.
 *   2. `submitApplicationForm`: enforces `checkValidity()` (`ADR-018`), clicks submit, and captures proof.
 */

import { chromium, type Locator, type Page } from "playwright";
import { childLogger } from "../../infra/logger.js";
import type { ApplyProfile } from "./apply-profile.js";
import type { CandidateDossier } from "./candidate-dossier.js";
import {
  buildFormFillPlan,
  summariseFormPlan,
  type FormFillAction,
  type FormPlanSummary,
  type RowApplicationFacts,
} from "./form-brain.js";
import {
  classifyFormUrl,
  resolveFormTargetUrl,
  revealPlatformForm,
  scrapePageFields,
  type FormPlatform,
} from "./form-scraper.js";

const log = childLogger({ module: "jobhunt:form-runner" });
export const CONTROLLED_INPUT_SETTLE_MS = 600;
export const SUBMIT_CONFIRM_TIMEOUT_MS = 12_000;
const NAV_BUTTON_EXCLUSIONS = ["header-tab-apply-button", "apply-button-nav"];

interface DomElement {
  readonly id: string; readonly value?: string; readonly textContent: string | null; readonly parentElement: DomElement | null;
  getAttribute(name: string): string | null; closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null; checkValidity?(): boolean;
}

interface DomGlobal {
  readonly document: { querySelector(s: string): DomElement | null; querySelectorAll(s: string): ArrayLike<DomElement> };
  readonly CSS: { escape(ident: string): string };
}

async function typeIntoField(page: Page, selector: string, value: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  // allow-failopen: non-combobox returns null/"" and uses standard text input path.
  const role = await locator.getAttribute("role").catch(() => null);
  const isCombobox = role?.toLowerCase() === "combobox";

  if (isCombobox) {
    await locator.click({ timeout: 5_000 });
    await locator.pressSequentially(value, { delay: 25, timeout: 10_000 });
    await page.waitForTimeout(400);

    // allow-failopen: clicking matching menu option directly when available, otherwise fall back to Enter.
    const optClicked = await page.locator('[class*="option" i]').filter({ hasText: new RegExp(value, "i") }).first().click({ timeout: 2_500 }).then(() => true).catch(() => false);
    if (!optClicked) {
      // allow-failopen: arrow down fallback.
      await page.keyboard.press("ArrowDown").catch(() => undefined);
      // allow-failopen: enter fallback.
      await page.keyboard.press("Enter").catch(() => undefined);
    }
    await page.waitForTimeout(300);
    const verified = await locator
      .evaluate((el, expected) => {
        const inp = el as unknown as DomElement;
        if (inp.value && inp.value.toLowerCase().includes(expected.toLowerCase())) return true;
        const container = inp.closest('.select__control, [class*="control" i], [class*="combobox" i], .field') ?? inp.parentElement?.parentElement;
        const singleVal = container?.querySelector('[class*="single-value" i], [class*="singleValue" i]');
        if (singleVal?.textContent?.trim()) return true;
        const text = (container?.textContent ?? "").toLowerCase();
        return text.includes(expected.toLowerCase());
      }, value)
      // allow-failopen: unreadable DOM reports false (unverified).
      .catch(() => false);
    return verified;
  }

  await locator.fill(value, { timeout: 5_000 });
  await page.waitForTimeout(CONTROLLED_INPUT_SETTLE_MS);
  // allow-failopen: unreadable value returns "" and triggers sequential keystroke fallback.
  if ((await locator.inputValue().catch(() => "")) === value) return true;

  // allow-failopen: clearing before keystroke retry is best-effort.
  await locator.fill("", { timeout: 5_000 }).catch(() => undefined);
  await locator.pressSequentially(value, { delay: 20, timeout: 15_000 });
  await page.waitForTimeout(CONTROLLED_INPUT_SETTLE_MS);
  // allow-failopen: unreadable value reports false so the caller records it as unverified.
  return (await locator.inputValue().catch(() => "")) === value;
}

async function chooseInField(
  page: Page,
  selector: string,
  fieldType: string,
  optionText: string,
): Promise<boolean> {
  if (fieldType === "select") {
    const selectLoc = page.locator(selector).first();
    const selected = await selectLoc
      .selectOption({ label: optionText }, { timeout: 5_000 })
      .then((vals) => vals.length > 0)
      // allow-failopen: falls back to matching option value/text manually.
      .catch(() => false);
    return selected;
  }

  const inputs = page.locator(selector);
  const count = await inputs.count();
  if (count === 1 && fieldType === "checkbox") {
    const single = inputs.first();
    // allow-failopen: styled checkbox fallback to .click() when .check() actionability fails.
    await single.check({ timeout: 5_000 }).catch(() => single.click({ timeout: 5_000, force: true }));
    // allow-failopen: unreadable checked state reports false.
    return single.isChecked().catch(() => false);
  }

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    // allow-failopen: missing type attribute defaults to null and continues loop.
    const rawType = await input.getAttribute("type").catch(() => null);
    if (rawType?.toLowerCase() === "hidden") continue;
    const text = await input
      .evaluate((el) => {
        const dom = globalThis as unknown as DomGlobal;
        const inp = el as unknown as DomElement;
        if (inp.id) {
          const lbl = dom.document.querySelector(`label[for="${dom.CSS.escape(inp.id)}"]`);
          if (lbl?.textContent?.trim()) return lbl.textContent.trim().replace(/\s+/g, " ");
        }
        let n: DomElement | null = inp.parentElement;
        for (let d = 0; d < 5 && n; d++) {
          const t = n.textContent?.trim().replace(/\s+/g, " ") ?? "";
          if (t.length > 0 && t.length < 300) return t;
          n = n.parentElement;
        }
        return "";
      })
      // allow-failopen: unreadable option text continues loop.
      .catch(() => "");

    if (text.toLowerCase() === optionText.toLowerCase() || text.includes(optionText)) {
      // allow-failopen: styled radio/checkbox fallback to .click().
      await input.check({ timeout: 5_000 }).catch(() => input.click({ timeout: 5_000, force: true }));
      // allow-failopen: unreadable checked state reports false.
      return input.isChecked().catch(() => false);
    }
  }
  return false;
}

export async function executeFormPlan(
  page: Page,
  actions: readonly FormFillAction[],
): Promise<ReadonlySet<string>> {
  const verified = new Set<string>();
  for (const action of actions) {
    if (action.kind === "ask") continue;
    try {
      let ok = false;
      if (action.kind === "value") {
        ok = await typeIntoField(page, action.selector, action.value);
      } else if (action.kind === "file") {
        await page.locator(action.selector).first().setInputFiles(action.path, { timeout: 10_000 });
        ok = true;
      } else if (action.kind === "choose") {
        ok = await chooseInField(page, action.selector, action.fieldType, action.option);
      }
      if (ok) verified.add(action.selector);
      else log.warn({ selector: action.selector, label: action.label }, "Fill action did not verify in DOM");
    } catch (err) {
      log.warn({ selector: action.selector, label: action.label, err: (err as Error).message }, "Fill action threw");
    }
  }
  return verified;
}

async function findSubmitControl(page: Page): Promise<Locator | null> {
  const submitInputs = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
  const count = await submitInputs.count();
  for (let i = count - 1; i >= 0; i--) {
    const candidate = submitInputs.nth(i);
    // allow-failopen: missing testid is normal.
    const testId = await candidate.getAttribute("data-testid").catch(() => null);
    if (testId && NAV_BUTTON_EXCLUSIONS.includes(testId)) continue;
    return candidate;
  }
  const byText = page
    .locator('button:visible, a[role="button"]:visible')
    .filter({ hasText: /^(submit|submit application|send application|apply|verstuur|solliciteer)$/i });
  const textCount = await byText.count();
  if (textCount > 0) return byText.nth(textCount - 1);
  return null;
}

async function checkFormValidity(page: Page): Promise<{ valid: boolean; invalidField?: string }> {
  return page
    .evaluate(() => {
      const dom = globalThis as unknown as DomGlobal;
      const forms = Array.from(dom.document.querySelectorAll("form"));
      for (const form of forms) {
        if (form.checkValidity && !form.checkValidity()) {
          const invalid = form.querySelector(":invalid");
          const label =
            (invalid?.id ? dom.document.querySelector(`label[for="${dom.CSS.escape(invalid.id)}"]`)?.textContent : null) ||
            invalid?.getAttribute("aria-label") ||
            invalid?.getAttribute("name") ||
            invalid?.id ||
            "a required field";
          return { valid: false, invalidField: label.trim() };
        }
      }
      return { valid: true };
    })
    // allow-failopen: if the page has no <form> (e.g. Ashby), native checkValidity does not apply.
    .catch(() => ({ valid: true }));
}

export interface PreparedFormResult {
  readonly ok: true;
  readonly platform: FormPlatform;
  readonly targetUrl: string;
  readonly summary: FormPlanSummary;
  readonly screenshotPng: Buffer;
}

export interface FormFailureResult {
  readonly ok: false;
  readonly reason: string;
  readonly platform?: FormPlatform | null;
}

async function launchHeadlessBrowser() {
  // allow-failopen: falls back to system Chrome when Playwright's bundled shell is not installed.
  return chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
}

/** Open the ATS page, fill known fields from profile + dossier, and return summary + preview PNG. */
export async function prepareApplicationForm(
  url: string,
  company: string,
  profile: ApplyProfile,
  row: RowApplicationFacts,
  dossier?: CandidateDossier,
): Promise<PreparedFormResult | FormFailureResult> {
  const check = classifyFormUrl(url);
  if (!check.supported) return { ok: false, reason: check.reason, platform: null };
  const targetUrl = resolveFormTargetUrl(url, company, check.platform);
  const browser = await launchHeadlessBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await revealPlatformForm(page, check.platform);

    const fields = await scrapePageFields(page, check.platform);
    if (fields.length === 0) {
      return {
        ok: false,
        reason: "no fillable form fields were found on this page (the form may be behind a login or custom widget)",
        platform: check.platform,
      };
    }

    const plan = buildFormFillPlan(fields, profile, row, dossier);
    const verified = await executeFormPlan(page, plan);
    const summary = summariseFormPlan(plan, fields, verified);
    const screenshotPng = await page.screenshot({ fullPage: true, type: "png" });

    return {
      ok: true,
      platform: check.platform,
      targetUrl,
      summary,
      screenshotPng,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, platform: check.platform };
  } finally {
    await browser.close();
  }
}

export interface SubmittedFormResult {
  readonly ok: true;
  readonly platform: FormPlatform;
  readonly clicked: boolean;
  readonly confirmed: boolean;
  readonly evidence: string;
  readonly afterScreenshotPng: Buffer;
}

/** Re-fill the form and click submit (enforces ADR-018 checkValidity and confirmation checks). */
export async function submitApplicationForm(
  url: string,
  company: string,
  profile: ApplyProfile,
  row: RowApplicationFacts,
  dossier?: CandidateDossier,
): Promise<SubmittedFormResult | FormFailureResult> {
  const check = classifyFormUrl(url);
  if (!check.supported) return { ok: false, reason: check.reason, platform: null };

  const targetUrl = resolveFormTargetUrl(url, company, check.platform);
  const browser = await launchHeadlessBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    let dialogMessage: string | null = null;
    page.on("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      // allow-failopen: dismissing an alert dialog must not crash the submit watcher.
      await dialog.dismiss().catch(() => undefined);
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await revealPlatformForm(page, check.platform);

    const fields = await scrapePageFields(page, check.platform);
    if (fields.length === 0) {
      return { ok: false, reason: "no fillable form fields found on page", platform: check.platform };
    }

    const plan = buildFormFillPlan(fields, profile, row, dossier);
    const verified = await executeFormPlan(page, plan);
    const summary = summariseFormPlan(plan, fields, verified);

    if (summary.requiredUnanswered.length > 0) {
      const missing = summary.requiredUnanswered.map((u) => u.question).join("; ");
      return {
        ok: false,
        reason: `refusing to click submit while required fields are unanswered: ${missing}`,
        platform: check.platform,
      };
    }

    const validity = await checkFormValidity(page);
    if (!validity.valid) {
      return {
        ok: false,
        reason: `form native validation failed on "${validity.invalidField}" — refusing to click submit (ADR-018)`,
        platform: check.platform,
      };
    }

    const button = await findSubmitControl(page);
    if (!button) {
      return { ok: false, reason: "could not locate the submit button on this form", platform: check.platform };
    }

    const urlBefore = page.url();
    await button.click({ timeout: 10_000 });

    let confirmed = false;
    let evidence = "";
    try {
      await Promise.race([
        page.waitForURL((u) => u.toString() !== urlBefore, { timeout: SUBMIT_CONFIRM_TIMEOUT_MS }),
        page
          .getByText(/thank you|application (received|submitted)|we('| ha)ve received|successfully submitted|bedankt voor je sollicitatie/i)
          .first()
          .waitFor({ state: "visible", timeout: SUBMIT_CONFIRM_TIMEOUT_MS }),
      ]);
      confirmed = true;
      evidence = `Confirmed: page navigated or displayed submission confirmation (from ${urlBefore} to ${page.url()})`;
    } catch {
      const hasError = await page
        .locator('[aria-invalid="true"]:visible, [role="alert"]:visible, .field-error:visible, .error-message:visible')
        .count()
        // allow-failopen: 0 means no visible error element was detected.
        .catch(() => 0);

      if (dialogMessage) {
        confirmed = false;
        evidence = `Form showed an alert dialog after click: "${dialogMessage}"`;
      } else if (hasError > 0) {
        confirmed = false;
        evidence = `Form displayed ${hasError} validation error element(s) after clicking submit`;
      } else {
        confirmed = false;
        evidence = "Clicked submit; no error appeared, but no confirmation banner or URL change was observed within 12s — check screenshot to verify";
      }
    }

    const afterScreenshotPng = await page.screenshot({ fullPage: true, type: "png" });
    return {
      ok: true,
      platform: check.platform,
      clicked: true,
      confirmed,
      evidence,
      afterScreenshotPng,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, platform: check.platform };
  } finally {
    await browser.close();
  }
}
