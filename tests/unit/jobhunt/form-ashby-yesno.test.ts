/**
 * Ashby Yes/No questions (2026-10-17 live /apply test, Mollie): two <button aria-pressed> plus a hidden checkbox
 * that Ashby ticks for "Yes". The scraper read the wrapper's text as one option "YesNo", and the runner's
 * text.includes() match ticked the checkbox for "No" too, which tells the employer "Yes".
 * Markup copied from jobs.ashbyhq.com (class names shortened).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeFormPlan } from "../../../src/tools/jobhunt/form-runner.js";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

const yesNo = (id: string, label: string, required: boolean) => `
  <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="${id}">
    <label class="_heading_f7cvd_52 ${required ? "_required_f7cvd_91" : ""} ashby-application-form-question-title" for="${id}">${label}</label>
    <div class="_container_1svni_28 _yesno_1e3gg_148 ashby-application-form-input-yesno">
      <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
      <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
      <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="${id}">
    </div>
  </div>`;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Ashby yes/no</title></head><body>
<div class="ashby-application-form-container">
  ${yesNo("c384b593-fe20-4f59-bae8-1c83f7451920", "Do you require a visa to legally work in the country where you are applying?", true)}
  ${yesNo("429934f8-0213-4c7b-bd6a-af96e354d1a4", "Do you have experience deploying LLMs?", false)}
</div>
<script>
  // Ashby's React handler: the pressed button wins, and the hidden checkbox mirrors "yes".
  document.querySelectorAll(".ashby-application-form-input-yesno").forEach((box) => {
    const box_ = box;
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      box_.querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      box_.querySelector("input").checked = b.dataset.option === "yes";
    }));
  });
</script>
</body></html>`;

const VISA = "c384b593-fe20-4f59-bae8-1c83f7451920";
const LLM = "429934f8-0213-4c7b-bd6a-af96e354d1a4";

describe("Ashby Yes/No button questions (Playwright)", () => {
  let server: http.Server;
  let url: string;
  let browser: Browser | null = null;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apply`;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      if (!(err as Error).message.includes("Executable doesn't exist")) throw err;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const state = (page: Page, id: string) =>
    page.locator(`[data-field-path="${id}"]`).evaluate((el) => ({
      yes: el.querySelector('[data-option="yes"]')?.getAttribute("aria-pressed"),
      no: el.querySelector('[data-option="no"]')?.getAttribute("aria-pressed"),
      checked: (el.querySelector("input") as unknown as { checked: boolean }).checked,
    }));

  it("scrapes a Yes/No button pair as a two-option question with its label and required flag", async () => {
    if (!browser) return; // bare CI container without Playwright Chromium
    const page = await browser.newPage();
    await page.goto(url);
    const fields = await scrapePageFields(page, "ashby");
    const visa = fields.find((f) => f.label.startsWith("Do you require a visa"));
    expect(visa).toMatchObject({ type: "radio-group", options: ["Yes", "No"], required: true });
    expect(fields.find((f) => f.label.startsWith("Do you have experience deploying"))).toMatchObject({
      options: ["Yes", "No"],
      required: false,
    });
    expect(fields.some((f) => f.options?.includes("YesNo"))).toBe(false);
    await page.close();
  }, 30_000);

  it("presses the matching button, and No never ticks the hidden Yes checkbox", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const fields = await scrapePageFields(page, "ashby");
    const visa = fields.find((f) => f.label.startsWith("Do you require a visa"))!;
    const llm = fields.find((f) => f.label.startsWith("Do you have experience deploying"))!;
    const verified = await executeFormPlan(page, [
      { kind: "choose", selector: visa.selector, fieldType: visa.type, option: "Yes", label: visa.label, confidence: 1, why: "test" },
      { kind: "choose", selector: llm.selector, fieldType: llm.type, option: "No", label: llm.label, confidence: 1, why: "test" },
    ]);

    expect(await state(page, VISA)).toEqual({ yes: "true", no: "false", checked: true });
    expect(await state(page, LLM)).toEqual({ yes: "false", no: "true", checked: false });
    expect(verified.has(visa.selector)).toBe(true);
    expect(verified.has(llm.selector)).toBe(true);
    await page.close();
  }, 30_000);

  it("does not verify an answer that is neither button", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const fields = await scrapePageFields(page, "ashby");
    const visa = fields.find((f) => f.label.startsWith("Do you require a visa"))!;
    const verified = await executeFormPlan(page, [
      { kind: "choose", selector: visa.selector, fieldType: visa.type, option: "YesNo", label: visa.label, confidence: 1, why: "test" },
    ]);
    expect(verified.has(visa.selector)).toBe(false);
    expect(await state(page, VISA)).toEqual({ yes: "false", no: "false", checked: false });
    await page.close();
  }, 30_000);
});
