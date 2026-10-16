/**
 * Playwright fixture for the widgets that failed in the 2026-10-16 live multi-ATS QA:
 *  - Greenhouse React-Select comboboxes (options only exist in a listbox after ArrowDown; the input stays empty)
 *  - Greenhouse async country autocomplete (options appear only after typing)
 *  - Ashby fieldset radio groups (the first label met walking up is an option label)
 *  - Greenhouse file-upload groups whose label[for] text is just "Attach"
 *  - a field with no label[for] (cost 30s per field on Workable)
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { buildFormFillPlan } from "../../../src/tools/jobhunt/form-brain.js";
import { executeFormPlan } from "../../../src/tools/jobhunt/form-runner.js";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

// data-options: fixed list shown on ArrowDown; data-async: list shown only after typing; data-delay: first open is
// slow (Greenhouse renders 244 countries); data-short: the control shows only the last word ("+91" for "India +91").
const combo = (id: string, label: string, data = "") => `
  <div class="field"><label id="${id}-label" for="${id}">${label}</label>
    <div class="select__control"><div class="select__value"></div>
      <input id="${id}" role="combobox" aria-required="true" aria-expanded="false" class="select__input" ${data} />
    </div></div>`;

// Workable: hashed class names, every question named only through aria-labelledby, and another field's
// <label> ("Cover letter (Optional)") higher up in the same section.
const WORKABLE = `
  <section class="styles--QXNVJ">
    <div class="styles--1jc0L"><label class="styles--3aPac" for="cl"><span>Cover letter</span> <span>(Optional)</span></label><textarea id="cl"></textarea></div>
    <div class="styles--1jc0L"><div class="styles--3IYUq"><div class="styles--3aPac"><span><strong>*</strong><span id="qa1_label">Do you have experience owning a core platform?</span></span></div>
      <div class="styles--Bnumk"><fieldset role="radiogroup" aria-labelledby="qa1_label">
        <div role="radio"><label><input type="radio" name="QA_1" value="true" required /><span>YES</span></label></div>
        <div role="radio"><label><input type="radio" name="QA_1" value="false" /><span>NO</span></label></div>
      </fieldset></div></div></div>
    <div class="styles--1jc0L"><div class="styles--3aPac"><span id="qa2_label">1) LinkedIn URL 2) Current location</span></div>
      <textarea id="qa2" aria-labelledby="qa2_label"></textarea></div>
    ${workableFile("photo_in", "Photo", "")}
    ${workableFile("resume_wk", "Resume", "required")}
  </section>`;

// Workable's label[for] holds only an icon whose <desc> fallback text would otherwise become the label.
function workableFile(id: string, label: string, required: string): string {
  return `<div class="styles--1jc0L"><div class="styles--3aPac"><span id="${id}_label">${label}</span></div>
      <div><label class="styles--3gG3Y" for="${id}"><svg viewBox="0 0 20 20"><desc aria-hidden="true"><p>SVGs not supported by this browser.</p></desc><use href="#icons.person"></use></svg></label>
        <label class="button--2de5X" id="description_${id}">Choose file</label>
        <input id="${id}" type="file" ${required} aria-labelledby="${id}_label description_${id}" /></div></div>`;
}

const fileGroup = (id: string, label: string) => `
  <div class="field-wrapper"><div class="file-upload" role="group">
    <div class="label upload-label">${label}</div>
    <div class="file-upload__wrapper"><div class="button-container"><div class="secondary-button"><div>
      <button type="button">Attach</button><label class="visually-hidden" for="${id}">Attach</label>
      <input id="${id}" type="file" />
    </div></div></div></div>
  </div></div>`;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>QA fixture</title></head><body>
<form id="application-form">
  ${combo("country", "Country*", 'data-options="United States +1|British Indian Ocean Territory +246|India +91|Indonesia +62|Netherlands +31" data-delay="700" data-short="1"')}
  ${combo("location", "Location (City)*", 'data-async="SAS Nagar Mohali, Punjab, India|Mohali, Maharashtra, India|Mumbai, Maharashtra, India"')}
  ${combo("q_go", "Do you have production experience with the programming language Go?*", 'data-options="Yes|No"')}
  ${combo("q_nl", "Are you based in The Netherlands or Ireland?*", 'data-options="Yes|No"')}
  ${fileGroup("resume", "Resume/CV*")}
  ${fileGroup("cover_letter", "Cover Letter")}
  <fieldset class="_fieldEntry_x">
    <label class="_heading_x _required_x">Where are you located?</label>
    <div class="_option_x"><input type="radio" name="loc" id="loc1" value="a" /><label class="_label_x" for="loc1">US Remote</label></div>
    <div class="_option_x"><input type="radio" name="loc" id="loc2" value="b" /><label class="_label_x" for="loc2">India Remote</label></div>
  </fieldset>
  <textarea id="why_us" aria-label="Why do you want to work here?"></textarea>
  ${WORKABLE}
</form>
<script>
  document.querySelectorAll('input[role="combobox"]').forEach((inp) => {
    const control = inp.closest(".select__control");
    const fixed = inp.dataset.options ? inp.dataset.options.split("|") : null;
    const pool = inp.dataset.async ? inp.dataset.async.split("|") : fixed || [];
    let menu = null;
    let timer = null;
    let firstOpen = true;
    const close = () => {
      clearTimeout(timer);
      if (menu) { menu.remove(); menu = null; }
      inp.setAttribute("aria-expanded", "false");
      inp.removeAttribute("aria-controls");
    };
    const open = (opts) => {
      close();
      if (opts.length === 0) return;
      menu = document.createElement("div");
      menu.id = "react-select-" + inp.id + "-listbox";
      menu.setAttribute("role", "listbox");
      for (const o of opts) {
        const d = document.createElement("div");
        d.setAttribute("role", "option");
        d.className = "select__option";
        d.textContent = o;
        d.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const shown = inp.dataset.short ? o.split(" ").pop() : o;
          control.querySelector(".select__value").innerHTML = '<div class="select__single-value">' + shown + "</div>";
          inp.value = "";
          close();
        });
        menu.appendChild(d);
      }
      control.parentElement.appendChild(menu);
      inp.setAttribute("aria-expanded", "true");
      inp.setAttribute("aria-controls", menu.id);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && fixed && !menu) {
        const delay = firstOpen ? Number(inp.dataset.delay || 0) : 0;
        firstOpen = false;
        timer = setTimeout(() => open(fixed), delay);
      }
      if (e.key === "Escape") close();
    });
    inp.addEventListener("input", () => {
      const q = inp.value.toLowerCase();
      open(q ? pool.filter((o) => o.toLowerCase().includes(q)) : fixed || []);
    });
    inp.addEventListener("blur", () => { inp.value = ""; close(); });
  });
</script>
</body></html>`;

const PROFILE: ApplyProfile = {
  first_name: "Pushkar",
  last_name: "Verma",
  email: "candidate@example.com",
  phone: "+91 00000 00000",
  answers: { location_city: "Mohali", location_country: "India", work_authorization: "requires-sponsorship" },
  question_bank: { "Do you have production experience with the programming language Go?*": "Yes" },
};

describe("form-combobox: React-Select, async autocomplete, Ashby radio groups (Playwright)", () => {
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

  it("scrapes combobox options, group labels and file labels without per-field label waits", async () => {
    if (!browser) return; // bare CI container without Playwright Chromium
    const page = await browser.newPage();
    await page.goto(url);
    const started = Date.now();
    const fields = await scrapePageFields(page, "greenhouse");
    expect(Date.now() - started).toBeLessThan(10_000);

    const byLabel = (start: string) => fields.find((f) => f.label.startsWith(start));
    expect(byLabel("Do you have production experience")).toMatchObject({ type: "select", options: ["Yes", "No"], required: true });
    expect(byLabel("Are you based in")).toMatchObject({ type: "select", options: ["Yes", "No"], required: true });
    expect(byLabel("Country")).toMatchObject({ type: "select", required: true });
    expect(byLabel("Country")?.options).toContain("India +91");
    expect(byLabel("Location (City)")).toMatchObject({ type: "text", required: true });
    expect(byLabel("Do you have experience owning")).toMatchObject({ type: "radio-group", options: ["YES", "NO"], required: true });
    expect(fields.find((f) => f.selector === '[id="qa2"]')?.label).toBe("1) LinkedIn URL 2) Current location");
    expect(fields.find((f) => f.selector === '[id="photo_in"]')?.label).toBe("Photo");
    expect(fields.find((f) => f.selector === '[id="resume_wk"]')).toMatchObject({ type: "file", label: "Resume", required: true });
    expect(fields.find((f) => f.selector === '[id="cl"]')?.label).toBe("Cover letter (Optional)");
    expect(byLabel("Where are you located?")).toMatchObject({ type: "radio-group", options: ["US Remote", "India Remote"], required: true });
    expect(fields.find((f) => f.selector === '[id="resume"]')).toMatchObject({ label: "Resume/CV*", required: true });
    expect(fields.find((f) => f.selector === '[id="cover_letter"]')).toMatchObject({ label: "Cover Letter", required: false });
    expect(byLabel("Why do you want to work here?")).toBeDefined();
    await page.close();
  }, 30_000);

  it("chooses React-Select options and picks the right autocomplete country, verified after blur", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const fields = await scrapePageFields(page, "greenhouse");
    const plan = buildFormFillPlan(fields, PROFILE);
    const verified = await executeFormPlan(page, plan);

    const singleValue = (id: string) =>
      page.locator(`[id="${id}"]`).evaluate((el) => el.closest(".select__control")?.querySelector(".select__single-value")?.textContent ?? "");
    expect(await singleValue("country")).toBe("+91");
    expect(await singleValue("location")).toBe("SAS Nagar Mohali, Punjab, India");
    expect(await singleValue("q_go")).toBe("Yes");
    expect(verified.has('[id="country"]')).toBe(true);
    expect(verified.has('[id="location"]')).toBe(true);
    expect(verified.has('[id="q_go"]')).toBe(true);

    const nl = plan.find((a) => a.label.startsWith("Are you based in"));
    expect(nl).toMatchObject({ kind: "ask", required: true, options: ["Yes", "No"] });
    expect(await singleValue("q_nl")).toBe("");
    await page.close();
  }, 30_000);

  // tsx (pnpm dev, harness and probe scripts) compiles with esbuild keepNames, which wraps named helpers inside
  // evaluate callbacks in __name(fn, "x"); the page has no __name, so the live harness threw on every form.
  it("installs the __name shim at both entry points so tsx-compiled evaluate callbacks run", async () => {
    if (!browser) return;
    for (const entry of [(p: Page) => scrapePageFields(p, "greenhouse"), (p: Page) => executeFormPlan(p, [])]) {
      const page = await browser.newPage();
      await page.goto(url);
      expect(await page.evaluate("typeof globalThis.__name")).toBe("undefined");
      await entry(page);
      expect(await page.evaluate("__name(() => 7, 'f')()")).toBe(7);
      await page.close();
    }
  }, 30_000);
});
