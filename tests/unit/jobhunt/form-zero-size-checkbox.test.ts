/**
 * Recruitee-hosted forms (Swisscom, Salland, S4D; 2026-10-20 dry run) draw their own box: the real
 * <input type="checkbox"> is 0px wide and its <label for> is what a person clicks. Playwright's check() and
 * click({force}) both refuse a zero-size element ("Element is not visible"), so Gender, privacy consent and
 * work-authorisation answers were never ticked and the submit was refused. Markup copied from
 * rotterdam.swisscom.com (class names shortened).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { checkFormValidity, executeFormPlan, submitApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";
import { revealPlatformForm } from "../../../src/tools/jobhunt/form-scraper.js";

const box = (name: string, i: number, value: string) => `
  <div class="row">
    <input type="checkbox" required id="input-${name}-${i}" value="${value}" name="${name}" class="box">
    <label for="input-${name}-${i}"><span aria-hidden="true">✓</span><span>${value}</span></label>
  </div>`;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  .box { width: 0; height: 0; margin: 0; padding: 0; border: 0; appearance: none; position: absolute; }
  label { display: inline-block; padding: 4px; }
</style></head><body><form>
  <fieldset><legend>Gender *</legend>${box("gender", 0, "Male")}${box("gender", 1, "Female")}</fieldset>
  <fieldset><legend>Privacy</legend>${box("privacy", 0, "I agree to the company privacy policy.")}</fieldset>
</form></body></html>`;

// A complete form whose Submit records that it was pressed: the dry run must fill it and stop before the click.
const READY = `<!doctype html><html><head><meta charset="utf-8"></head><body><form onsubmit="event.preventDefault(); document.title = 'SENT'">
  <label for="fn">First name*</label><input id="fn" name="first_name" type="text" required>
  <label for="ln">Last name*</label><input id="ln" name="last_name" type="text" required>
  <label for="em">Email*</label><input id="em" name="email" type="email" required>
  <button type="submit">Submit application</button>
</form></body></html>`;

// Recruitee (Salland, TSG; 2026-10-20): the first :invalid match is the <fieldset>, and the box itself has no id or
// name label, only aria-labelledby. The refusal must still name the field the founder has to fix.
const UNNAMED = `<!doctype html><html><head><meta charset="utf-8"></head><body><form novalidate>
  <fieldset><legend>My information</legend>
    <input type="checkbox" required aria-labelledby="c0"><div id="c0">I agree to the privacy statement</div>
  </fieldset>
</form></body></html>`;

// Recruitee on the employer's own domain (tsg.careers, Salland; 2026-10-20): the job page /o/<slug> carries the
// application form hidden behind a tab, so nothing typed into it lands. The real form lives at /o/<slug>/c/new.
const HIDDEN_RECRUITEE = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Engineer</h1>
  <div style="display:none"><form id="offer-application-form"><input name="candidate.name" required></form></div>
</body></html>`;
const RECRUITEE_NEW = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <form id="offer-application-form"><input name="candidate.name" required></form></body></html>`;

describe("zero-size styled checkboxes (Playwright)", () => {
  let server: http.Server;
  let url: string;
  let browser: Browser | null = null;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const path = (_req.url ?? "").split("?")[0] ?? "";
      const pages: Record<string, string> = { "/ready": READY, "/unnamed": UNNAMED, "/o/engineer": HIDDEN_RECRUITEE, "/o/engineer/c/new": RECRUITEE_NEW };
      res.end(pages[path] ?? FIXTURE);
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

  it("ticks the chosen option of a group through its label, and only that one", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const verified = await executeFormPlan(page, [
      { kind: "choose", selector: 'input[name="gender"]', fieldType: "checkbox-group", option: "Female", label: "Gender *", confidence: 1, why: "test" },
    ]);
    expect(verified.has('input[name="gender"]')).toBe(true);
    expect(await page.isChecked("#input-gender-1")).toBe(true);
    expect(await page.isChecked("#input-gender-0")).toBe(false);
    await page.close();
  }, 30_000);

  it("ticks a single consent checkbox through its label", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const verified = await executeFormPlan(page, [
      { kind: "choose", selector: 'input[name="privacy"]', fieldType: "checkbox", option: "I agree to the company privacy policy.", label: "Privacy", confidence: 1, why: "test" },
    ]);
    expect(verified.has('input[name="privacy"]')).toBe(true);
    expect(await page.isChecked("#input-privacy-0")).toBe(true);
    await page.close();
  }, 30_000);

  it("dryRun fills and checks a complete form but never presses Submit", async () => {
    if (!browser) return;
    const profile: ApplyProfile = { first_name: "Pushkar", last_name: "Verma", email: "pushkar@example.test", phone: "+31 600000000", answers: {} };
    const r = await submitApplicationForm(url.replace("/apply", "/ready"), "Acme", profile, {}, undefined, undefined, true);
    expect(r).toMatchObject({ ok: true, clicked: false, confirmed: false });
  }, 60_000);

  it("names the invalid input, not its fieldset, through aria-labelledby", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url.replace("/apply", "/unnamed"));
    expect(await checkFormValidity(page)).toEqual({ valid: false, invalidField: "I agree to the privacy statement" });
    await page.close();
  }, 30_000);

  it("moves from a Recruitee job page with a hidden form to its /c/new apply page, keeping the query", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url.replace("/apply", "/o/engineer?utm_source=x"));
    await revealPlatformForm(page, "generic");
    expect(new URL(page.url()).pathname).toBe("/o/engineer/c/new");
    expect(new URL(page.url()).search).toBe("?utm_source=x");
    expect(await page.locator('input[name="candidate.name"]').isVisible()).toBe(true);
    await page.close();
  }, 30_000);
});
