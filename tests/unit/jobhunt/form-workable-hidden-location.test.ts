/**
 * Capgemini on Workable (2026-11-15 live, /apply j0fbcc218): hidden #city, #postcode and #country sit in empty labels
 * beside #firstname (named via aria-labelledby). The scraper labelled all three "First name" and tried to type the
 * founder's first name into them; the Telegram card then showed "Couldn't fill *First name" three times.
 */
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

const FIXTURE = `<form>
  <div><span id="firstname_label">First name<strong>*</strong></span>
    <input id="firstname" name="firstname" type="text" aria-labelledby="firstname_label" required style="width:200px;height:30px"></div>
  <div><span id="lastname_label">Last name*</span>
    <input id="lastname" name="lastname" type="text" aria-labelledby="lastname_label" style="width:200px;height:30px"></div>
  <div>
    <label class="styles--3aPac"><input id="city" name="city" type="text" aria-hidden="true" tabindex="-1" style="width:1px;height:1px"></label>
    <label class="styles--3aPac"><input id="postcode" name="postcode" type="text" aria-hidden="true" tabindex="-1" style="width:1px;height:1px"></label>
    <label class="styles--3aPac"><input id="country" name="country" type="text" aria-hidden="true" tabindex="-1" style="width:1px;height:1px"></label>
  </div>
  <div><label for="notes">Notes</label><input id="notes" name="notes" type="text" style="width:200px;height:30px">
    <input id="extra" name="extra" type="text" style="width:200px;height:30px"></div>
</form>`;

describe("Workable hidden location mirrors (Playwright)", () => {
  let browser: Browser | null = null;
  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      if (!(err as Error).message.includes("Executable doesn't exist")) throw err;
    }
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("skips aria-hidden tabindex=-1 inputs and never borrows another control's label", async () => {
    if (!browser) return; // bare CI container without Playwright Chromium
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const fields = await scrapePageFields(page, "workable");
    const ids = fields.map((f) => f.selector);
    expect(ids.some((s) => /city|postcode|country/.test(s))).toBe(false);
    expect(fields.filter((f) => f.label.startsWith("First name"))).toHaveLength(1);
    const extra = fields.find((f) => f.selector.includes("extra"));
    expect(extra?.label ?? "").not.toBe("Notes");
    await page.close();
  }, 30_000);
});
