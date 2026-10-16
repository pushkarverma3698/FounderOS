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
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { buildFormFillPlan } from "../../../src/tools/jobhunt/form-brain.js";
import { executeFormPlan } from "../../../src/tools/jobhunt/form-runner.js";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

const combo = (id: string, label: string, options?: string) => `
  <div class="field"><label id="${id}-label" for="${id}">${label}</label>
    <div class="select__control"><div class="select__value"></div>
      <input id="${id}" role="combobox" aria-required="true" aria-expanded="false" class="select__input"${options ? ` data-options="${options}"` : ""} />
    </div></div>`;

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
  ${combo("country", "Country*")}
  ${combo("q_go", "Do you have production experience with the programming language Go?*", "Yes|No")}
  ${combo("q_nl", "Are you based in The Netherlands or Ireland?*", "Yes|No")}
  ${fileGroup("resume", "Resume/CV*")}
  ${fileGroup("cover_letter", "Cover Letter")}
  <fieldset class="_fieldEntry_x">
    <label class="_heading_x _required_x">Where are you located?</label>
    <div class="_option_x"><input type="radio" name="loc" id="loc1" value="a" /><label class="_label_x" for="loc1">US Remote</label></div>
    <div class="_option_x"><input type="radio" name="loc" id="loc2" value="b" /><label class="_label_x" for="loc2">India Remote</label></div>
  </fieldset>
  <textarea id="why_us" aria-label="Why do you want to work here?"></textarea>
</form>
<script>
  const COUNTRIES = ["British Indian Ocean Territory +246", "India +91", "Indonesia +62", "Netherlands +31"];
  document.querySelectorAll('input[role="combobox"]').forEach((inp) => {
    const control = inp.closest(".select__control");
    const fixed = inp.dataset.options ? inp.dataset.options.split("|") : null;
    let menu = null;
    const close = () => {
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
          control.querySelector(".select__value").innerHTML = '<div class="select__single-value">' + o + "</div>";
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
      if (e.key === "ArrowDown" && fixed && !menu) open(fixed);
      if (e.key === "Escape") close();
    });
    inp.addEventListener("input", () => {
      const q = inp.value.toLowerCase();
      const src = fixed || COUNTRIES;
      open(q ? src.filter((o) => o.toLowerCase().includes(q)) : fixed || []);
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
    expect(byLabel("Country")).toMatchObject({ type: "text", required: true });
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
    expect(await singleValue("country")).toBe("India +91");
    expect(await singleValue("q_go")).toBe("Yes");
    expect(verified.has('[id="country"]')).toBe(true);
    expect(verified.has('[id="q_go"]')).toBe(true);

    const nl = plan.find((a) => a.label.startsWith("Are you based in"));
    expect(nl).toMatchObject({ kind: "ask", required: true, options: ["Yes", "No"] });
    expect(await singleValue("q_nl")).toBe("");
    await page.close();
  }, 30_000);
});
