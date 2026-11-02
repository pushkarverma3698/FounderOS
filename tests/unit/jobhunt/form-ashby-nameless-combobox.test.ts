/**
 * Ashby Location (2026-10-19 live, Mollie): a required question rendered as a bare
 * <input type=text role=combobox placeholder="Start typing..."> with no name, no id, no required attribute and no
 * <form>. The scraper dropped it, the Mini App said "12 of 12 filled", Submit was clicked and Ashby refused silently.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { buildFormFillPlan, summariseFormPlan } from "../../../src/tools/jobhunt/form-brain.js";
import { executeFormPlan, submitApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";
import { emptyStarredFields } from "../../../src/tools/jobhunt/form-required-guard.js";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Ashby Location</title></head><body>
<div class="ashby-application-form-container">
  <div class="ashby-application-form-field-entry">
    <label class="_heading_f7cvd_52 ashby-application-form-question-title" for="_systemfield_name">Name*</label>
    <input id="_systemfield_name" name="_systemfield_name" type="text" />
  </div>
  <div class="ashby-application-form-field-entry">
    <label class="_heading_f7cvd_52 ashby-application-form-question-title" for="_systemfield_email">Email*</label>
    <input id="_systemfield_email" name="_systemfield_email" type="email" />
  </div>
  <div class="ashby-application-form-field-entry">
    <label class="_heading_f7cvd_52 ashby-application-form-question-title">Location*</label>
    <div class="_container_wrap">
      <input type="text" role="combobox" placeholder="Start typing..." aria-controls="loc-list" autocomplete="off" />
      <ul id="loc-list" role="listbox" hidden></ul>
    </div>
  </div>
  <button type="button">Submit Application</button>
</div>
<script>
  const input = document.querySelector('[role=combobox]');
  const list = document.getElementById('loc-list');
  const PLACES = ['Mohali, Punjab, India', 'Mohali, Nepal', 'Berlin, Germany'];
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    list.innerHTML = '';
    PLACES.filter((p) => q && p.toLowerCase().includes(q)).forEach((p) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = p;
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => { input.value = p; list.hidden = true; });
      list.appendChild(li);
    });
    list.hidden = list.children.length === 0;
  });
</script>
</body></html>`;

// A generic-platform page: the scraper only reads inputs inside a <form>, so the starred field outside it is unseen.
const GENERIC = `<!doctype html><html><body>
<form id="application-form"><label for="first_name">First Name</label><input id="first_name" name="first_name" type="text" /></form>
<div><label for="size">Company size*</label><input id="size" type="text" /></div>
<button type="submit">Submit</button></body></html>`;

const BASE: ApplyProfile = {
  first_name: "Pushkar",
  last_name: "Verma",
  email: "pushkar@example.test",
  phone: "+91 90000 00000",
  answers: {},
};
const WITH_CITY: ApplyProfile = { ...BASE, answers: { location_city: "Mohali", location_country: "India" } };

describe("Ashby nameless, idless combobox (Playwright)", () => {
  let server: http.Server;
  let url: string;
  let browser: Browser | null = null;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(_req.url === "/generic" ? GENERIC : FIXTURE);
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

  const open = async (): Promise<Page> => {
    const page = await browser!.newPage();
    await page.goto(url);
    return page;
  };

  it("keeps the field, with its label, a stable selector, and required from the star", async () => {
    if (!browser) return; // bare CI container without Playwright Chromium
    const page = await open();
    const fields = await scrapePageFields(page, "ashby");
    const loc = fields.find((f) => f.label.startsWith("Location"));
    expect(loc).toMatchObject({ type: "text", label: "Location*", required: true });
    expect(loc?.selector).toMatch(/^\[data-fos-field="\d+"\]$/);
    expect(await page.locator(loc!.selector).count()).toBe(1);
    await page.close();
  }, 30_000);

  it("surfaces an unknown location as an unanswered REQUIRED question and never invents one", async () => {
    if (!browser) return;
    const page = await open();
    const fields = await scrapePageFields(page, "ashby");
    const plan = buildFormFillPlan(fields, BASE, {});
    const verified = await executeFormPlan(page, plan);
    const summary = summariseFormPlan(plan, fields, verified);
    expect(summary.requiredUnanswered.map((u) => u.question)).toContain("Location*");
    expect(await page.locator("[role=combobox]").inputValue()).toBe("");
    await page.close();
  }, 30_000);

  it("types the known location and picks the matching suggestion through the combobox path", async () => {
    if (!browser) return;
    const page = await open();
    const fields = await scrapePageFields(page, "ashby");
    const plan = buildFormFillPlan(fields, WITH_CITY, {});
    const verified = await executeFormPlan(page, plan);
    const loc = fields.find((f) => f.label.startsWith("Location"))!;
    expect(verified.has(loc.selector)).toBe(true);
    expect(await page.locator("[role=combobox]").inputValue()).toBe("Mohali, Punjab, India");
    await page.close();
  }, 30_000);

  it("submitApplicationForm refuses to click Submit while a starred field is empty, naming it", async () => {
    if (!browser) return;
    const r = await submitApplicationForm(url.replace("/apply", "/generic"), "Acme", BASE, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("refusing to click submit while required fields are empty: Company size*");
  }, 60_000);

  it("the pre-submit guard names an empty starred field, then passes once it is filled", async () => {
    if (!browser) return;
    const page = await open();
    await page.locator("#_systemfield_name").fill("Pushkar Verma");
    await page.locator("#_systemfield_email").fill("p@example.test");
    expect(await emptyStarredFields(page)).toEqual(["Location*"]);
    await page.locator("[role=combobox]").fill("Berlin");
    expect(await emptyStarredFields(page)).toEqual([]);
    await page.close();
  }, 30_000);

  it("the guard does not block a required multi-select that already shows chosen values", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.setContent(`<div><label for="q_offices">Which offices could you work from?*</label>
      <div class="select__control"><div class="select__multi-value"><div class="select__multi-value__label">Amsterdam</div></div>
      <input id="q_offices" type="text" role="combobox" value="" style="width:40px;height:20px"></div></div>`);
    expect(await emptyStarredFields(page)).toEqual([]);
    await page.close();
  }, 30_000);
});
