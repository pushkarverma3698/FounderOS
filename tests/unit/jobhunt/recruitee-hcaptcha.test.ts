/**
 * First real Mini App submit (Payter e9053885, Recruitee, 2026-10-20). Two misses:
 * 1. Recruitee draws hCaptcha from captcha-base.recruiteecdn.com with no captcha class or name on any input: a
 *    script#hcaptcha-api-script-id, an iframe titled "Widget containing checkbox for hCaptcha security challenge"
 *    inside div#input-captchaToken-*, and a hidden captchaToken field. The scraper said "no captcha", the Mini App
 *    showed "Ready to submit", and the click bounced off the challenge.
 * 2. Recruitee renders empty [role=alert] placeholders (6 on Payter before any input), so the outcome read
 *    "Form displayed 6 validation error element(s)" when no error was shown.
 * Markup reduced from the Payter form; no network.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";
import { awaitSubmitOutcome } from "../../../src/tools/jobhunt/held-submit.js";

const FIELDS = `
  <label for="n">Full name*</label><input id="n" name="candidate.name" required>
  <label for="e">Email*</label><input id="e" name="candidate.email" type="email" required>`;

const HCAPTCHA = `<!doctype html><html><head><meta charset="utf-8">
  <script id="hcaptcha-api-script-id" async></script></head><body>
  <form id="offer-application-form">${FIELDS}
    <div id="input-captchaToken-4f2a"><iframe title="Widget containing checkbox for hCaptcha security challenge" src="about:blank" width="300" height="80"></iframe></div>
    <input type="hidden" name="captchaToken" value="">
    <button type="submit">Send</button>
  </form></body></html>`;

// The challenge iframe is injected by the CDN script and may not exist yet when the scraper runs.
const HCAPTCHA_NOT_LOADED = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <form id="offer-application-form">${FIELDS}
    <div id="input-captchaToken-4f2a"></div><input type="hidden" name="captchaToken" value="">
  </form></body></html>`;

// Invisible reCAPTCHA (v3 / size=invisible) shows no challenge; it must not turn a row into "Submit it yourself".
const INVISIBLE_RECAPTCHA = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <form>${FIELDS}</form>
  <iframe title="reCAPTCHA" src="about:blank?k=x&size=invisible" width="256" height="60"></iframe></body></html>`;

const EMPTY_ALERTS = `<!doctype html><html><head><meta charset="utf-8"></head><body><form>${FIELDS}
  ${'<div role="alert" style="min-height:4px"></div>'.repeat(6)}</form></body></html>`;

const ONE_REAL_ALERT = `<!doctype html><html><head><meta charset="utf-8"></head><body><form>${FIELDS}
  ${'<div role="alert" style="min-height:4px"></div>'.repeat(5)}<div role="alert">Email is required</div></form></body></html>`;

describe("Recruitee hCaptcha and empty alerts (Playwright)", () => {
  let server: http.Server;
  let base: string;
  let browser: Browser | null = null;

  beforeAll(async () => {
    const pages: Record<string, string> = {
      "/hcaptcha": HCAPTCHA,
      "/hcaptcha-not-loaded": HCAPTCHA_NOT_LOADED,
      "/invisible": INVISIBLE_RECAPTCHA,
      "/empty-alerts": EMPTY_ALERTS,
      "/real-alert": ONE_REAL_ALERT,
    };
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pages[(req.url ?? "").split("?")[0] ?? ""] ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  const captchaFields = async (path: string) => {
    const page = await browser!.newPage();
    await page.goto(base + path);
    const fields = await scrapePageFields(page, "generic");
    await page.close();
    return fields.filter((f) => f.isCaptcha || f.type === "captcha");
  };

  it("reports Recruitee's hCaptcha widget as a captcha field", async () => {
    if (!browser) return;
    expect(await captchaFields("/hcaptcha")).toHaveLength(1);
  }, 30_000);

  it("reports it before the challenge iframe has loaded", async () => {
    if (!browser) return;
    expect(await captchaFields("/hcaptcha-not-loaded")).toHaveLength(1);
  }, 30_000);

  it("does not flag an invisible reCAPTCHA", async () => {
    if (!browser) return;
    expect(await captchaFields("/invisible")).toHaveLength(0);
  }, 30_000);

  const outcome = async (path: string) => {
    const page = await browser!.newPage();
    await page.goto(base + path);
    const r = await awaitSubmitOutcome(page, page.url(), { message: null }, { watchForCode: false });
    await page.close();
    return r;
  };

  it("does not count empty [role=alert] placeholders as validation errors", async () => {
    if (!browser) return;
    const r = await outcome("/empty-alerts");
    expect(r.kind).toBe("unconfirmed");
    expect(r.evidence).not.toMatch(/validation error/);
  }, 30_000);

  it("counts only alerts with text and quotes that text", async () => {
    if (!browser) return;
    const r = await outcome("/real-alert");
    expect(r.kind).toBe("unconfirmed");
    expect(r.evidence).toMatch(/1 validation error/);
    expect(r.evidence).toContain("Email is required");
  }, 30_000);
});
