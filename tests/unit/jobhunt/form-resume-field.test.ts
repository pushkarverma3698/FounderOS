/**
 * Issue #1353: prod needs_you rows said "N required question(s) unanswered: Resume" (17) and "Cv *" (4).
 * Root cause: until #1319 (2026-11-22) the shadow pass handed the form no resume file unless the apply profile
 * configured one, and a file field with no file on hand is a required question. The label mapping itself was
 * fine; these tests pin both halves so neither can regress: no file means "unanswered" (loudly), a file means
 * the CV goes into every CV-labelled upload and never into a cover-letter upload.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { routeLane } from "../../../src/tools/jobhunt/apply-lane.js";
import { buildFormFillPlan, labelMatches, summariseFormPlan, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";
import { executeFormPlan } from "../../../src/tools/jobhunt/form-runner.js";

const PROFILE: ApplyProfile = { first_name: "Pushkar", last_name: "Verma", email: "p@example.test" } as ApplyProfile;
const PDF = "/tmp/form-resume-field-cv.pdf";
const file = (label: string, selector = "#f", required = true): ScrapedField => ({ selector, type: "file", label, required });

describe("CV upload fields (#1353)", () => {
  it.each(["Resume", "Cv *", "CV", "Resume *", "Curriculum vitae", "Lebenslauf", "Upload your CV"])(
    "%s: unanswered without a file, filled with the CV when one is resolved",
    (label) => {
      const fields = [file(label)];
      const none = summariseFormPlan(buildFormFillPlan(fields, PROFILE, {}), fields);
      expect(none.requiredUnanswered.map((q) => q.label)).toEqual([label]);

      const plan = buildFormFillPlan(fields, PROFILE, { resumePath: PDF });
      expect(plan).toEqual([expect.objectContaining({ kind: "file", path: PDF, selector: "#f" })]);
      const summary = summariseFormPlan(plan, fields, new Set(["#f"]));
      expect(summary.requiredUnanswered).toEqual([]);
      expect(summary.filledAnswers).toHaveLength(1);
    },
  );

  it("the lane reason names the CV when no file is on hand, and clears once it is", () => {
    const fields = [file("Resume"), file("Cv *", "#g")];
    const open = routeLane({ kind: "prepared", platform: "lever", summary: summariseFormPlan(buildFormFillPlan(fields, PROFILE, {}), fields) });
    expect(open).toEqual({ lane: "needs_you", reason: "2 required question(s) unanswered: Resume; Cv *" });
    const plan = buildFormFillPlan(fields, PROFILE, { resumePath: PDF });
    const done = routeLane({ kind: "prepared", platform: "lever", summary: summariseFormPlan(plan, fields, new Set(["#f", "#g"])) });
    expect(done.lane).toBe("auto");
  });

  it("never puts the CV in a cover-letter upload, and sends the letter only to the letter field", () => {
    const fields = [file("Resume", "#r"), file("Cover letter", "#c"), file("Motivatiebrief", "#m", false)];
    const noLetter = buildFormFillPlan(fields, PROFILE, { resumePath: PDF });
    expect(noLetter.find((a) => a.selector === "#r")).toMatchObject({ kind: "file", path: PDF });
    expect(noLetter.find((a) => a.selector === "#c")).toMatchObject({ kind: "ask" });
    expect(noLetter.find((a) => a.selector === "#m")).toMatchObject({ kind: "ask" });
    const withLetter = buildFormFillPlan(fields, PROFILE, { resumePath: PDF, coverLetterPath: "/tmp/letter.pdf" });
    expect(withLetter.find((a) => a.selector === "#c")).toMatchObject({ kind: "file", path: "/tmp/letter.pdf" });
    expect(withLetter.find((a) => a.selector === "#r")).toMatchObject({ kind: "file", path: PDF });
  });

  it("matches 'cv' only as a whole word", () => {
    expect(labelMatches("Cv *", "resume")).toBe(true);
    expect(labelMatches("Your CV/Resume", "resume")).toBe(true);
    expect(labelMatches("Favourite recv", "resume")).toBe(false);
  });
});

describe("form runner uploads the CV (Playwright)", () => {
  let server: http.Server;
  let url: string;
  let browser: Browser | null = null;
  beforeAll(async () => {
    fs.writeFileSync(PDF, "%PDF-1.4 test");
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><form><label for="cv">Cv *</label><input type="file" id="cv" name="cv" required>
        <label for="cl">Cover letter</label><input type="file" id="cl" name="cl"></form>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = null; // no Playwright Chromium (bare CI): the case skips like its siblings
    }
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sets the PDF on the 'Cv *' input and leaves the cover-letter input empty", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(url);
    const fields = [file("Cv *", "#cv"), file("Cover letter", "#cl", false)];
    const plan = buildFormFillPlan(fields, PROFILE, { resumePath: PDF });
    const verified = await executeFormPlan(page, plan);
    expect(verified.has("#cv")).toBe(true);
    expect(await page.locator("#cv").evaluate((el) => (el as unknown as { files: { name: string }[] }).files[0]?.name)).toBe("form-resume-field-cv.pdf");
    expect(await page.locator("#cl").evaluate((el) => (el as unknown as { files: unknown[] }).files.length)).toBe(0);
    await page.close();
  }, 30_000);
});
