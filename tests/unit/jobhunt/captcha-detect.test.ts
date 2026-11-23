/**
 * #1322: the detector missed reCAPTCHA Enterprise (Greenhouse hosted boards, invisible) and Cloudflare Turnstile
 * (Workable), so the rows routed to `auto` and failed at Submit. Pure fixtures per vendor, a live-DOM fixture where
 * the script is injected after load (SmartRecruiters does this), and the lane + Mac lease rules end to end.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captchaVendorOf, detectCaptchaVendor, VENDOR_LABEL } from "../../../src/tools/jobhunt/captcha-detect.js";
import { routeLane } from "../../../src/tools/jobhunt/apply-lane.js";
import { summariseFormPlan } from "../../../src/tools/jobhunt/form-filled.js";
import { isMacEligibleReason } from "../../../src/tools/jobhunt/mac-worker-rules.js";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

describe("captchaVendorOf (script src, iframe src, widget class)", () => {
  it.each([
    ["https://www.google.com/recaptcha/enterprise.js?render=6Lc", "recaptcha-enterprise"],
    ["https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=x&size=invisible", "recaptcha-enterprise"],
    ["https://challenges.cloudflare.com/turnstile/v0/api.js", "turnstile"],
    ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/0x4", "turnstile"],
    ["https://js.hcaptcha.com/1/api.js", "hcaptcha"],
    ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html", "hcaptcha"],
    ["https://cdn.jsdelivr.net/npm/friendly-challenge@0.9.14/widget.min.js", "friendly-captcha"],
    ["https://cdn.friendlycaptcha.com/widget.js", "friendly-captcha"],
    ["cf-turnstile", "turnstile"],
    ["frc-captcha", "friendly-captcha"],
    ["h-captcha", "hcaptcha"],
  ] as const)("%s -> %s", (ref, vendor) => {
    expect(captchaVendorOf(ref)).toBe(vendor);
  });

  it("leaves plain reCAPTCHA v2/v3, analytics and empty strings alone", () => {
    expect(captchaVendorOf("https://www.google.com/recaptcha/api.js?render=x")).toBeNull();
    expect(captchaVendorOf("https://www.googletagmanager.com/gtm.js")).toBeNull();
    expect(captchaVendorOf("")).toBeNull();
  });
});

describe("detectCaptchaVendor", () => {
  it("returns the first vendor found across refs and the enterprise global", () => {
    expect(detectCaptchaVendor({ refs: ["/app.js", "https://challenges.cloudflare.com/turnstile/v0/api.js"], enterpriseGlobal: false })).toBe("turnstile");
    expect(detectCaptchaVendor({ refs: ["/app.js"], enterpriseGlobal: true })).toBe("recaptcha-enterprise");
    expect(detectCaptchaVendor({ refs: ["/app.js"], enterpriseGlobal: false })).toBeNull();
  });
});

describe("lane + Mac lease", () => {
  const fields = (label: string) => [{ selector: "#x", type: "captcha" as const, label, required: false, isCaptcha: true }];
  it.each(Object.values(VENDOR_LABEL))("a %s row goes to hand_off with a reason the Mac lease takes", (label) => {
    const summary = summariseFormPlan([], fields(label));
    expect(summary.hasCaptcha).toBe(true);
    const v = routeLane({ kind: "prepared", platform: "greenhouse", summary });
    expect(v.lane).toBe("hand_off");
    expect(v.reason).toContain(label);
    expect(isMacEligibleReason(v.reason)).toBe(true);
  });
  it("a reCAPTCHA Enterprise row is leasable", () => {
    const summary = summariseFormPlan([], fields(VENDOR_LABEL["recaptcha-enterprise"]));
    expect(isMacEligibleReason(routeLane({ kind: "prepared", platform: "greenhouse", summary }).reason)).toBe(true);
  });
  it("a bare CAPTCHA field keeps the old reason", () => {
    const v = routeLane({ kind: "prepared", platform: "lever", summary: summariseFormPlan([], fields("CAPTCHA")) });
    expect(v.reason).toBe("CAPTCHA or reCAPTCHA widget on the form; a person has to solve it");
  });
});

const FORM = `<label for="n">Full name*</label><input id="n" name="name" required>`;
const PAGES: Record<string, string> = {
  "/enterprise": `<!doctype html><body><form>${FORM}</form><script src="https://www.google.com/recaptcha/enterprise.js?render=6Lc"></script></body>`,
  "/turnstile": `<!doctype html><body><form>${FORM}<div class="cf-turnstile" data-sitekey="0x4"></div></form></body>`,
  "/frc": `<!doctype html><body><form>${FORM}<div class="frc-captcha" data-sitekey="FC"></div></form></body>`,
  // SmartRecruiters-style: nothing in the static HTML, the loader is injected by script after load.
  "/injected": `<!doctype html><body><form>${FORM}</form><script>setTimeout(()=>{const s=document.createElement("script");s.src="https://challenges.cloudflare.com/turnstile/v0/api.js";document.head.appendChild(s);},50)</script></body>`,
  // Nebius 2026-11-16: a OneTrust overlay covers the page (it intercepts the Submit click) and the Turnstile loader
  // is added only after the visitor rejects cookies.
  "/consent": `<!doctype html><body><form>${FORM}<button type="submit" id="go">Submit</button></form>
    <div id="onetrust-consent-sdk"><div class="onetrust-pc-dark-filter" style="position:fixed;inset:0;z-index:99;background:#0008"></div>
    <button id="onetrust-reject-all-handler" style="position:fixed;top:0;left:0;z-index:100" onclick="this.parentNode.remove();var s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js';document.head.appendChild(s)">Reject All</button></div></body>`,
  "/plain": `<!doctype html><body><form>${FORM}</form></body>`,
};

describe("live DOM (Playwright)", () => {
  let server: http.Server;
  let base: string;
  let browser: Browser | null = null;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGES[req.url ?? ""] ?? "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch().catch(() => null);
  });
  afterAll(async () => {
    await browser?.close();
    server.close();
  });

  const scrape = async (path: string) => {
    const page = await browser!.newPage();
    // Block the third-party loaders: the tag in the DOM is what is detected, never the network.
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(base + path);
    const fields = await scrapePageFields(page, "greenhouse");
    await page.close();
    return fields.filter((f) => f.isCaptcha);
  };

  it.each([
    ["/enterprise", "reCAPTCHA Enterprise"],
    ["/turnstile", "Cloudflare Turnstile"],
    ["/frc", "Friendly Captcha"],
    ["/injected", "Cloudflare Turnstile"],
  ])("%s is reported as %s", async (path, label) => {
    if (!browser) return;
    const caps = await scrape(path);
    expect(caps.map((c) => c.label)).toEqual([label]);
  });

  it("a cookie banner is declined: the held-back Turnstile loader shows and Submit becomes clickable (Nebius)", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(base + "/consent");
    await expect(page.locator("#go").click({ trial: true, timeout: 600 })).rejects.toThrow(/intercepts pointer events/);
    const caps = (await scrapePageFields(page, "greenhouse")).filter((f) => f.isCaptcha);
    expect(caps.map((c) => c.label)).toEqual(["Cloudflare Turnstile"]);
    await page.locator("#go").click({ trial: true, timeout: 2000 });
    await page.close();
  });

  it("a plain form reports none", async () => {
    if (!browser) return;
    expect(await scrape("/plain")).toEqual([]);
  });
});
