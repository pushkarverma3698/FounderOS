/**
 * Live probe 2026-11-15 found three ways a form got an answer that was not the founder's:
 *  - Entrata's "expected yearly compensation (INR)" got the EUR floor "52284".
 *  - An unset country became "India" and an unset employer "FounderOS / Turicks" (hardcoded defaults).
 *  - Lever's CV parser overwrote a verified LinkedIn URL with a truncated one after we typed it.
 */
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { buildFormFillPlan, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";
import { executeFormPlan } from "../../../src/tools/jobhunt/form-runner.js";

const PROFILE: ApplyProfile = {
  first_name: "Test",
  last_name: "Person",
  email: "test@example.com",
  phone: "+31 6 00000000",
  answers: { salary_floor_eur_year: 52284 },
};

const text = (selector: string, label: string, required = true): ScrapedField => ({ selector, type: "text", label, required });
const planFor = (field: ScrapedField, profile: ApplyProfile = PROFILE, dossier?: Parameters<typeof buildFormFillPlan>[3]) =>
  buildFormFillPlan([field], profile, {}, dossier)[0]!;

describe("salary answers respect the currency the form asks in", () => {
  it.each([
    "What is your expected yearly compensation? (INR)✱",
    "What is your minimum expected salary (LPA, CTC)?",
    "Expected salary in USD",
    "Salary expectation (₹)",
  ])("asks instead of sending the EUR number: %s", (label) => {
    expect(planFor(text("#s", label)).kind).toBe("ask");
  });

  it("still fills a salary question with no other currency", () => {
    const action = planFor(text("#s", "What are your salary expectations?"));
    expect(action).toMatchObject({ kind: "value", value: "52284" });
  });

  it("uses a stored answer that already names the asked currency", () => {
    const dossier = { facts: { "salary expectation": "30 LPA" }, qaPairs: {} } as unknown as Parameters<typeof buildFormFillPlan>[3];
    expect(planFor(text("#s", "Expected CTC (LPA)"), PROFILE, dossier)).toMatchObject({ kind: "value", value: "30 LPA" });
  });
});

describe("no invented defaults", () => {
  it("asks for country and current company when the profile has none", () => {
    expect(planFor(text("#c", "Country")).kind).toBe("ask");
    expect(planFor(text("#e", "Current company")).kind).toBe("ask");
  });

  it("uses the founder's own saved values", () => {
    const p: ApplyProfile = { ...PROFILE, answers: { ...PROFILE.answers, location_country: "Netherlands", current_company: "Acme" } };
    expect(planFor(text("#c", "Country"), p)).toMatchObject({ kind: "value", value: "Netherlands" });
    expect(planFor(text("#e", "Current company"), p)).toMatchObject({ kind: "value", value: "Acme" });
  });
});

// The upload triggers a "CV parse" that overwrites the URL field after 400 ms; a second script overwrites the
// already-verified name field the first time the URL field is typed into. Both must end holding our values.
const FIXTURE = `<!doctype html><html><body><form>
<input id="name" type="text"><input id="li" type="text"><input id="cv" type="file">
<script>
document.getElementById("cv").addEventListener("change", () => setTimeout(() => {
  document.getElementById("li").value = "http://linkedin.com/in/trunc-";
}, 400));
document.getElementById("li").addEventListener("input", () => {
  if (window.__late) return; window.__late = true;
  setTimeout(() => { document.getElementById("name").value = "Parsed Name"; }, 0);
});
</script></form></body></html>`;

describe("CV parsing cannot overwrite verified values (Playwright)", () => {
  let server: http.Server;
  let url: string;
  let browser: Browser | null = null;
  let cv: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apply`;
    cv = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cv-")), "cv.pdf");
    await fs.writeFile(cv, "%PDF-1.4\n");
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

  it("uploads first, types after the parse, and retypes a value overwritten late", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const li = "https://www.linkedin.com/in/test-person-123";
    // Plan order puts the file last, as on Lever's real form; the executor must still upload it first.
    const verified = await executeFormPlan(page, [
      { kind: "value", selector: "#name", label: "Full name", value: "Test Person", confidence: 1, why: "t" },
      { kind: "value", selector: "#li", label: "LinkedIn", value: li, confidence: 1, why: "t" },
      { kind: "file", selector: "#cv", label: "Resume", path: cv, confidence: 1, why: "t" },
    ]);
    expect(await page.inputValue("#li")).toBe(li);
    expect(await page.inputValue("#name")).toBe("Test Person");
    expect([...verified].sort()).toEqual(["#cv", "#li", "#name"]);
    await page.close();
  }, 30_000);
});
