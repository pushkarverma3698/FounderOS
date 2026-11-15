/**
 * Workable's phone box is intl-tel-input: typing "+31 6 12345678" moves +31 into the country flag and leaves
 * "6 12345678" in the input, so a strict read-back called a correct fill unverified and /apply asked for the phone
 * again (JoVE, 2026-11-14).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeFormPlan } from "../../../src/tools/jobhunt/form-runner.js";
import { phoneShownMatches } from "../../../src/tools/jobhunt/form-phone.js";

describe("phoneShownMatches", () => {
  it.each([
    ["+31 6 12345678", "6 12345678"],
    ["+31 6 12345678", "+31 6 12345678"],
    ["+31 6 12345678", "06 12345678"],
    ["+31-612345678", "612345678"],
    ["0031612345678", "6 12345678"],
  ])("%s shown as %s is the same number", (typed, shown) => {
    expect(phoneShownMatches(typed, shown)).toBe(true);
  });
  it.each([
    ["+31 6 12345678", ""],
    ["+31 6 12345678", "6 1234"],
    ["+31 6 12345678", "6 12345679"],
    ["+31 6 12345678", "abc"],
  ])("%s shown as %s is not", (typed, shown) => {
    expect(phoneShownMatches(typed, shown)).toBe(false);
  });
});

const WIDGET = `<!doctype html><html><body><form>
  <label for="p">Phone</label>
  <input id="p" name="phone" type="tel" required>
  <label for="t">Name</label><input id="t" name="t" type="text">
  <script>
    // What intl-tel-input does: the dial code moves into the flag, the national number stays.
    document.getElementById("p").addEventListener("input", (e) => {
      const m = /^\\+31\\s*(.*)$/.exec(e.target.value);
      if (m) e.target.value = m[1];
    });
  </script>
</form></body></html>`;

describe("phone widget fill", () => {
  let server: http.Server;
  let browser: Browser | undefined;
  let url: string;
  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(WIDGET); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
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

  it("verifies a phone the widget reformatted, and still rejects a plain text mismatch", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const verified = await executeFormPlan(page, [
      { kind: "value", selector: "#p", label: "Phone", value: "+31 6 12345678", confidence: 1, why: "test" },
    ]);
    expect(verified.has("#p")).toBe(true);
    expect(await page.inputValue("#p")).toBe("6 12345678");
    await page.close();
  }, 30_000);
});
