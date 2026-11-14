/**
 * SmartRecruiters (KPN, Bosch; 2026-11-14): /apply failed with "no fillable form fields". The job page is only a posting,
 * its "I'm interested" link opens a separate apply app (/oneclick-ui/...) that sits behind a DataDome bot check, and a
 * dead posting says "this job has expired". Fixtures mirror those three states.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noFieldsReason, pickSmartRecruitersApplyHref } from "../../../src/tools/jobhunt/form-smartrecruiters.js";
import { revealPlatformForm, scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

const APPLY = "/oneclick-ui/company/Acme/publication/aaaa-bbbb";
const posting = (href: string) =>
  `<!doctype html><html><body><h1>Engineer</h1><a href="https://example.test/share">Share</a><a href="${href}">Ik ben geïnteresseerd</a></body></html>`;
const PAGES: Record<string, string> = {
  "/Acme/1": posting(`${APPLY}?dcr_ci=Acme`),
  "/Acme/2": posting("/oneclick-ui/company/Acme/publication/cccc-dddd?dcr_ci=Acme"),
  "/Acme/expired": `<!doctype html><html><body><h1>Engineer</h1><button>Sorry, this job has expired</button></body></html>`,
  [APPLY]: `<!doctype html><html><body><form><label for="fn">First name*</label><input id="fn" name="firstName" required>
    <label for="em">Email*</label><input id="em" name="email" type="email" required></form></body></html>`,
  "/oneclick-ui/company/Acme/publication/cccc-dddd": `<!doctype html><html><body><iframe src="https://geo.captcha-delivery.com/interstitial/?x=1"></iframe></body></html>`,
};

describe("pickSmartRecruitersApplyHref", () => {
  it("picks the apply-app link and resolves it against the page", () => {
    const hrefs = ["https://x.test/share", "/oneclick-ui/company/KPN/publication/u-1?dcr_ci=KPN"];
    expect(pickSmartRecruitersApplyHref(hrefs, "https://jobs.smartrecruiters.com/KPN/7")).toBe(
      "https://jobs.smartrecruiters.com/oneclick-ui/company/KPN/publication/u-1?dcr_ci=KPN",
    );
  });
  it("returns null when the posting has no apply link", () => {
    expect(pickSmartRecruitersApplyHref(["/KPN/8-other-job", ""], "https://jobs.smartrecruiters.com/KPN/7")).toBeNull();
  });
});

describe("SmartRecruiters apply flow (Playwright)", () => {
  let server: http.Server;
  let base: string;
  let browser: Browser | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGES[(req.url ?? "").split("?")[0] ?? ""] ?? "<html></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
    } catch {
      browser = null; // no browser installed: the Playwright cases skip, as in the sibling tests
    }
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("follows the interested link to the apply app and scrapes its fields", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(`${base}/Acme/1`);
    await revealPlatformForm(page, "smartrecruiters");
    expect(new URL(page.url()).pathname).toBe(APPLY);
    const fields = await scrapePageFields(page, "smartrecruiters");
    expect(fields.map((f) => f.label)).toEqual(expect.arrayContaining(["First name*", "Email*"]));
    await page.close();
  }, 30_000);

  it("names the DataDome bot check instead of the generic message", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(`${base}/Acme/2`);
    await revealPlatformForm(page, "smartrecruiters");
    expect(await scrapePageFields(page, "smartrecruiters")).toHaveLength(0);
    expect(await noFieldsReason(page, "smartrecruiters")).toMatch(/^SmartRecruiters: .*DataDome bot check/);
    await page.close();
  }, 30_000);

  it("names an expired posting", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(`${base}/Acme/expired`);
    await revealPlatformForm(page, "smartrecruiters");
    expect(await noFieldsReason(page, "smartrecruiters")).toMatch(/^SmartRecruiters: this job has expired/);
    await page.close();
  }, 30_000);

  it("keeps the generic message for other platforms", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(`${base}/Acme/expired`);
    expect(await noFieldsReason(page, "lever")).toMatch(/^no fillable form fields were found/);
    await page.close();
  }, 30_000);
});
