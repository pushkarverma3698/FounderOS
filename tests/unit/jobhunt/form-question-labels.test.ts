/**
 * Lever, Entrata (2026-11-15 live probe): every typed custom question was scraped as "Type your response" (its
 * placeholder), and a Yes/No group whose question ran past 250 characters took the label of the first question
 * in the card ("What is your preferred name?"). The founder would be asked nonsense in Telegram. Markup below is
 * the real Lever card shape, trimmed.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrapePageFields } from "../../../src/tools/jobhunt/form-scraper.js";

const LONG_Q = `Do you have any relatives currently employed by Acme? Relatives would include a spouse or civil union partner, parents, stepparents, foster parents, father-in-law, mother-in-law, children, stepchildren, foster children, sons-in-law, daughters-in-law, grandparents, grandchildren, brothers, sisters. This question is asked solely for the purpose of enforcing that policy)`;

const radio = (field: string, values: string[]): string =>
  `<ul data-qa="multiple-choice">${values
    .map((v) => `<li><label><input type="radio" name="cards[c1][${field}]" value="${v}" required="required" /><span class="application-answer-alternative">${v}</span></label></li>`)
    .join("")}</ul>`;

const FIXTURE = `<!doctype html><html><body><form id="application-form">
<ul>
<li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input type="text" name="name" required></div></label></li>
</ul>
<div class="section application-form" data-qa="additional-cards"><ul>
<li class="application-question custom-question"><div><div class="application-label full-width text"><div class="text">What is your preferred name?<span class="required">✱</span></div></div><div class="application-field full-width required-field"><input required="required" class="card-field-input" type="text" placeholder="Type your response" value="" name="cards[c1][field0]" /></div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width multiple-choice"><div class="text">How did you learn about this position?<span class="required">✱</span></div></div><div class="application-field full-width required-field">${radio("field1", ["LinkedIn", "Other"])}</div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width text"><div class="text">Total Years of Relevant Work Experience<span class="required">✱</span></div></div><div class="application-field full-width required-field"><input required="required" class="card-field-input" type="text" placeholder="Type your response" value="" name="cards[c1][field2]" /></div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width multiple-choice"><div class="text">${LONG_Q}<span class="required">✱</span></div></div><div class="application-field full-width required-field">${radio("field3", ["Yes", "No"])}</div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width text"><div class="text">Any links?</div></div><div class="application-field full-width"><input class="card-field-input" type="text" placeholder="e.g. https://example.com" value="" name="cards[c1][field4]" /></div></div></li>
</ul></div>
<div><input type="text" name="nickname" placeholder="Nickname"></div>
</form></body></html>`;

describe("question labels come from the field's own container (Playwright)", () => {
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

  it("labels typed questions with the question, never the placeholder, and never borrows a neighbour's label", async () => {
    if (!browser) return; // bare CI container without Playwright Chromium
    const page = await browser.newPage();
    await page.goto(url);
    const fields = await scrapePageFields(page, "lever");
    const byName = (n: string) => fields.find((f) => f.selector.includes(n))?.label;
    expect(byName("[field0]")).toBe("What is your preferred name?✱");
    expect(byName("[field1]")).toBe("How did you learn about this position?✱");
    expect(byName("[field2]")).toBe("Total Years of Relevant Work Experience✱");
    expect(byName("[field3]")).toBe(`${LONG_Q}✱`);
    expect(byName("[field4]")).toBe("Any links?");
    // A field with no question text of its own still falls back to its placeholder.
    expect(byName("nickname")).toBe("Nickname");
    expect(fields.map((f) => f.label)).not.toContain("Type your response");
    await page.close();
  }, 30_000);
});
