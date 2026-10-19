/**
 * Held submit: the emailed confirmation-code step (ADR-018 amendment 2026-10-18).
 * Real headless chromium with page.setContent fixtures (the markup is a hypothesis, no Greenhouse HTML is saved):
 *  1. detectEmailCodePrompt: true for a code prompt with an input (or N single-character boxes) and a greyed Submit;
 *     false for a confirmation page, an error page, an ordinary form, and a prompt whose Submit is still enabled.
 *  2. awaitSubmitOutcome: a click that reveals the code step is code-needed, not unconfirmed; a thank-you is confirmed.
 *  3. enterEmailCode: types the code, clicks Submit, runs the same check; a wrong code keeps the page for re-entry.
 *  4. The hold: ten minutes on an injected clock, then the browser closes; releaseHeld closes it too.
 */

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  CODE_HOLD_MS, awaitSubmitOutcome, detectEmailCodePrompt, enterEmailCode, heldCodeInfo, heldRowIdsForTests, holdForEmailCode,
  onHeldExpired, releaseHeld, setHeldClockForTests,
} = await import("../../../src/tools/jobhunt/held-submit.js");

const PROMPT = "We sent a verification code to you@example.com. Enter the 8-character code to submit your application.";
const THANKS = "document.body.innerHTML = '<h1>Thank you for applying</h1>';";

const codePage = (inputs: string): string => `<!doctype html><body>
  <form><p>${PROMPT}</p>${inputs}<button type='submit' id='go' disabled>Submit application</button></form>
  <script>
    const boxes = [...document.querySelectorAll('input')];
    const go = document.getElementById('go');
    const value = () => boxes.map((b) => b.value).join('');
    boxes.forEach((b) => b.addEventListener('input', () => { go.disabled = value().length < 8; }));
    go.addEventListener('click', (e) => {
      e.preventDefault();
      if (value() === 'ABCD1234') { ${THANKS} }
      else { document.body.insertAdjacentHTML('beforeend', '<p role=alert>That code is not right.</p>'); }
    });
  </script></body>`;
const ONE_INPUT = codePage("<input id='security_code' maxlength='8' aria-label='Security code'>");
const EIGHT_BOXES = codePage(Array.from({ length: 8 }, () => "<input maxlength='1' size='1'>").join(""));

describe("held submit", () => {
  let browser: Browser | null = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
    } catch (err) {
      if (!(err as Error).message.includes("Executable doesn't exist")) throw err;
    }
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(async () => {
    for (const id of heldRowIdsForTests()) await releaseHeld(id);
    setHeldClockForTests();
  });

  async function open(html: string): Promise<Page | null> {
    if (!browser) return null; // no browser binary on a bare CI container, like form-runner.test.ts
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(html);
    return page;
  }

  describe("detectEmailCodePrompt", () => {
    it("is true for one code input and for a row of single-character boxes", async () => {
      for (const html of [ONE_INPUT, EIGHT_BOXES]) {
        const page = await open(html);
        if (!page) return;
        expect(await detectEmailCodePrompt(page)).toBe(true);
      }
    });

    it("is false for a confirmation page, an error page, an ordinary form and a prompt whose Submit is enabled", async () => {
      const fixtures = [
        "<h1>Thank you for applying</h1><p>We have received your application.</p>",
        "<form><input aria-label=Email type=email required><p role=alert>Email is required</p><button type=submit disabled>Submit application</button></form>",
        "<form><label>First name <input name=first_name></label><button type=submit>Submit application</button></form>",
        `<form><p>${PROMPT}</p><input maxlength=8 aria-label=Code><button type=submit>Submit application</button></form>`,
      ];
      for (const html of fixtures) {
        const page = await open(html);
        if (!page) return;
        expect(await detectEmailCodePrompt(page)).toBe(false);
      }
    });
  });

  describe("awaitSubmitOutcome", () => {
    const REVEAL = [
      "<button id=b type=submit>Submit application</button><script>",
      "document.getElementById('b').onclick = function () {",
      "document.body.insertAdjacentHTML('beforeend', '<p>" + PROMPT + "</p><input maxlength=8 aria-label=Code>');",
      "this.disabled = true; };</script>",
    ].join("");
    const THANK_YOU = "<button id=b>Submit application</button><script>document.getElementById('b').onclick = function () {" + THANKS + "};</script>";

    it("reports code-needed when the click reveals the code step", async () => {
      const page = await open(REVEAL);
      if (!page) return;
      await page.click("#b");
      const outcome = await awaitSubmitOutcome(page, page.url(), { message: null }, { watchForCode: true });
      expect(outcome.kind).toBe("code-needed");
    }, 30_000);

    it("reports confirmed when the click leads to a thank-you", async () => {
      const page = await open(THANK_YOU);
      if (!page) return;
      await page.click("#b");
      const outcome = await awaitSubmitOutcome(page, page.url(), { message: null }, { watchForCode: true });
      expect(outcome.kind).toBe("confirmed");
    }, 30_000);

    it("names the invisible bot check when a click on a reCAPTCHA page changes nothing (Mollie, Ashby, 2026-10-19)", async () => {
      const page = await open("<form><button id=b type=submit>Submit Application</button></form><div class=grecaptcha-badge></div>"
        + "<script>document.querySelector('form').onsubmit = (e) => e.preventDefault();</script>");
      if (!page) return;
      await page.click("#b");
      const outcome = await awaitSubmitOutcome(page, page.url(), { message: null }, { watchForCode: false });
      expect(outcome.kind).toBe("unconfirmed");
      expect(outcome.evidence).toMatch(/hidden bot check \(reCAPTCHA\)/);
      expect(outcome.evidence).toMatch(/submit it yourself/i);
    }, 30_000);
  });

  describe("enterEmailCode", () => {
    const hold = (page: Page, close = vi.fn(async () => undefined)) =>
      holdForEmailCode("row-1", { page, browser: { close }, dialog: { message: null }, findSubmit: async () => page.locator("#go") });

    it("types the code, clicks Submit and confirms; the hold ends and the browser closes", async () => {
      const page = await open(ONE_INPUT);
      if (!page) return;
      const close = vi.fn(async () => undefined);
      hold(page, close);
      const result = await enterEmailCode("row-1", "ABCD1234");
      expect(result.kind).toBe("confirmed");
      expect(close).toHaveBeenCalledTimes(1);
      expect(heldCodeInfo("row-1")).toBeNull();
    }, 30_000);

    it("types one character per box when the form has N boxes", async () => {
      const page = await open(EIGHT_BOXES);
      if (!page) return;
      hold(page);
      expect((await enterEmailCode("row-1", "ABCD1234")).kind).toBe("confirmed");
    }, 30_000);

    it("keeps the page after a wrong code so the founder can try again", async () => {
      const page = await open(ONE_INPUT);
      if (!page) return;
      const close = vi.fn(async () => undefined);
      hold(page, close);
      const wrong = await enterEmailCode("row-1", "WRONG123");
      expect(wrong.kind).toBe("code-needed");
      if (wrong.kind === "code-needed") expect(wrong.evidence).toContain("That code is not right");
      expect(close).not.toHaveBeenCalled();
      expect(heldCodeInfo("row-1")).not.toBeNull();
    }, 30_000);

    it("rejects a malformed code and answers none when nothing is held", async () => {
      expect(await enterEmailCode("row-1", "ABCD1234")).toEqual({ kind: "none" });
      const page = await open(ONE_INPUT);
      if (!page) return;
      hold(page);
      expect((await enterEmailCode("row-1", "no way")).kind).toBe("invalid");
      expect((await enterEmailCode("row-1", "AB")).kind).toBe("invalid");
    }, 30_000);
  });

  describe("the hold", () => {
    const fakePage = {} as Page;
    const input = (close: () => Promise<void>) => ({ page: fakePage, browser: { close }, dialog: { message: null }, findSubmit: async () => null });

    it("closes the browser after ten minutes, tells the caller, and forgets the row", async () => {
      let now = 1_000_000;
      const timers: Array<() => void> = [];
      setHeldClockForTests({ now: () => now, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
      const close = vi.fn(async () => undefined);
      const expired = vi.fn();
      holdForEmailCode("row-1", input(close));
      onHeldExpired("row-1", expired);
      expect(heldCodeInfo("row-1", now)).toEqual({ secondsLeft: CODE_HOLD_MS / 1000 });
      now += CODE_HOLD_MS;
      timers[0]?.();
      await new Promise((r) => setTimeout(r, 5));
      expect(close).toHaveBeenCalledTimes(1);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(heldRowIdsForTests()).toEqual([]);
    });

    it("releaseHeld (cancel) closes a held page once and is harmless when nothing is held", async () => {
      const close = vi.fn(async () => undefined);
      holdForEmailCode("row-1", input(close));
      expect(await releaseHeld("row-1")).toBe(true);
      expect(await releaseHeld("row-1")).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
