import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { type ApplicationPacket } from "../../tools/jobhunt/apply-packet.js";
import { getProfile } from "../../tools/jobhunt/profile-config.js";
import { atsForUrl, fieldMapFor, resolveApplicationUrl, type FieldMap } from "./ats-adapters.js";
import { childLogger } from "../../infra/logger.js";
import { type ApplicationTask } from "../../db/schema.js";
import * as path from "node:path";

const log = childLogger({ module: "jobhunt:browser-executor" });

export class BrowserException extends Error {
  constructor(message: string, public context: any) {
    super(message);
    this.name = "BrowserException";
  }
}

export class BrowserApplicationExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  public page: Page | null = null;

  constructor(private dryRun: boolean = false) {}

  async init() {
    if (!this.browser) {
      // Running headless on VPS. If GUI is needed, Xvfb could wrap the node process.
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({ acceptDownloads: false });
    }
    if (this.page && !this.page.isClosed()) {
      await this.page.close();
    }
    this.page = await this.context!.newPage();
  }

  async close() {
    if (this.page && !this.page.isClosed()) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }

  async execute(packet: ApplicationPacket, profileId: string, stateCallback: (state: ApplicationTask["state"]) => Promise<void>) {
    await this.init();
    if (!this.page) throw new Error("Page not initialized");

    const profile = getProfile(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);

    const ats = atsForUrl(packet.applyUrl);
    const targetUrl = resolveApplicationUrl(packet.applyUrl, ats);

    log.info({ targetUrl, ats }, "Navigating to job application");
    const response = await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    
    if (response && response.status() >= 400) {
      throw new BrowserException(`Failed to load page, status: ${response.status()}`, { url: targetUrl });
    }

    // specific waits for slow SPAs like Ashby or Workable
    if (ats === "ashby") {
      try { await this.page.waitForSelector('[name="_systemfield_name"]', { timeout: 8000, state: "visible" }); } catch (e) {}
    } else if (ats === "workable") {
      try { await this.page.waitForSelector('#firstname', { timeout: 8000, state: "visible" }); } catch (e) {}
    }

    await stateCallback("FILLING");
    
    const fieldMap = fieldMapFor(packet.applyUrl);
    if (!fieldMap) {
      // Unrecognized form - trigger AI handler
      throw new BrowserException("Unrecognized ATS form structure", { url: targetUrl, html: await this.page.content() });
    }

    const plan = this.plannedFills(fieldMap, profile as any);
    let filledCount = 0;
    for (const { label, selectors, value } of plan) {
      if (!value || !value.trim()) continue;
      const filled = await this._fillFirst(this.page, selectors, value);
      if (filled) filledCount++;
    }

    // Resume upload
    if (packet.pdfPath && fieldMap.resume) {
      const uploaded = await this._uploadFirst(this.page, fieldMap.resume, packet.pdfPath);
      if (!uploaded) {
        log.warn("Failed to upload resume deterministically. Sending to AI exception handler.");
        throw new BrowserException("Could not find resume upload field", { url: targetUrl });
      }
    }

    await stateCallback("REVIEWING");

    // In a fully autonomous system we need to deterministically click submit and verify.
    // If we want a human to verify, we pause here. The prompt asks for
    // "Deterministic Form Execution -> Verification -> FounderOS State / Receipt"
    // "escalate blockers to FounderOS -> resume after human response"
    // Since we are to "never duplicate", "submit applications", "verify submission".
    
    // For now we will try to find a submit button and click it, then verify URL change.
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Submit application")',
      'button:has-text("Apply")',
      '#submit_app'
    ];

    await stateCallback("SUBMITTING");
    
    if (this.dryRun) {
      log.info("Dry run mode: skipping submission click.");
      return;
    }

    const submitted = await this._clickSubmit(this.page, submitSelectors);
    if (!submitted) {
      throw new BrowserException("Submit button not found", { url: targetUrl, html: await this.page.content() });
    }

    await stateCallback("VERIFYING");
    try {
      await this.page.waitForNavigation({ timeout: 10000, waitUntil: "domcontentloaded" });
    } catch (e) {
      // Might be a JS redirect or success modal without navigation.
      const currentUrl = this.page.url();
      if (currentUrl === targetUrl) {
         // Did not navigate. Check for error messages on form
         const hasErrors = await this.page.evaluate(() => {
            // @ts-ignore: document exists in browser context
            return document.querySelectorAll('[class*="error"], [class*="invalid"]').length > 0;
         });
         if (hasErrors) {
            throw new BrowserException("Form submission failed with validation errors", { url: targetUrl });
         }
      }
    }
  }

  private plannedFills(fieldMap: FieldMap, profile: any) {
    const plan: { label: string, selectors: string[], value: string }[] = [];
    if (fieldMap.full_name) plan.push({ label: "name", selectors: fieldMap.full_name, value: `${profile.firstName} ${profile.lastName}` });
    if (fieldMap.first_name) plan.push({ label: "first name", selectors: fieldMap.first_name, value: profile.firstName });
    if (fieldMap.last_name) plan.push({ label: "last name", selectors: fieldMap.last_name, value: profile.lastName });
    if (fieldMap.email) plan.push({ label: "email", selectors: fieldMap.email, value: profile.email });
    if (fieldMap.phone) plan.push({ label: "phone", selectors: fieldMap.phone, value: profile.phone });
    if (fieldMap.linkedin && profile.linkedin) plan.push({ label: "linkedin", selectors: fieldMap.linkedin, value: profile.linkedin });
    if (fieldMap.website && profile.website) plan.push({ label: "website", selectors: fieldMap.website, value: profile.website });
    return plan;
  }

  private async _fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: "visible", timeout: 2000 });
        await loc.scrollIntoViewIfNeeded();
        await loc.focus();
        await page.keyboard.press("Meta+A");
        await page.keyboard.type(value, { delay: 15 });
        log.debug(`[TYPE OK] ${selector} -> ${value}`);
        return true;
      } catch (err) {
        log.trace(`[TYPE FAIL] ${selector}: ${err}`);
      }
    }
    return false;
  }

  private async _uploadFirst(page: Page, selectors: string[], filePath: string): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: "attached", timeout: 2000 });
        await loc.setInputFiles(path.resolve(filePath), { timeout: 4000 });
        log.debug(`[UPLOAD OK] ${selector} -> ${filePath}`);
        return true;
      } catch (err) {
        log.trace(`[UPLOAD FAIL] ${selector}: ${err}`);
      }
    }
    return false;
  }

  private async _clickSubmit(page: Page, selectors: string[]): Promise<boolean> {
     for (const selector of selectors) {
        try {
           const loc = page.locator(selector).first();
           await loc.waitFor({ state: "visible", timeout: 2000 });
           await loc.scrollIntoViewIfNeeded();
           await loc.click({ timeout: 2000 });
           log.debug(`[CLICK OK] ${selector}`);
           return true;
        } catch (err) {
           log.trace(`[CLICK FAIL] ${selector}: ${err}`);
        }
     }
     return false;
  }
}
