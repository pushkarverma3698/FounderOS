/**
 * End-to-End Playwright tests — form-scraper.ts & form-runner.ts
 * ==============================================================
 * Spins up a real local HTTP server serving multi-ATS application forms and
 * drives them with headless Chromium:
 *  1. `prepareApplicationForm` fills known fields + CV PDF from `ApplyProfile`
 *     and `CandidateDossier`, captures a real PNG screenshot, and reports any
 *     unknown question in `summary.unanswered`.
 *  2. `submitApplicationForm` refuses to click submit while a required field
 *     is unanswered (`ADR-018`).
 *  3. Once the candidate answers the unknown question (`recordLearnedAnswer`),
 *     `submitApplicationForm` fills 100% of fields, passes `checkValidity()`,
 *     clicks the real `<button type="submit">`, detects the confirmation banner,
 *     and returns `confirmed: true` with a post-submit proof screenshot.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import {
  parseDossierMarkdown,
  readCandidateDossier,
  recordLearnedAnswer,
} from "../../../src/tools/jobhunt/candidate-dossier.js";
import {
  prepareApplicationForm,
  submitApplicationForm,
} from "../../../src/tools/jobhunt/form-runner.js";
import { classifyFormUrl, resolveFormTargetUrl } from "../../../src/tools/jobhunt/form-scraper.js";

const FORM_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Acme AI — Senior Engineer Application</title></head>
<body>
  <form id="application-form">
    <div>
      <label for="first_name">First Name *</label>
      <input id="first_name" name="first_name" type="text" required />
    </div>
    <div>
      <label for="last_name">Last Name *</label>
      <input id="last_name" name="last_name" type="text" required />
    </div>
    <div>
      <label for="email">Email *</label>
      <input id="email" name="email" type="email" required />
    </div>
    <div>
      <label for="phone">Phone *</label>
      <input id="phone" name="phone" type="tel" required />
    </div>
    <div>
      <label for="resume">Resume/CV *</label>
      <input id="resume" name="resume" type="file" required />
    </div>
    <div>
      <label for="sponsorship">Do you require visa sponsorship to work in the Netherlands? *</label>
      <select id="sponsorship" name="sponsorship" required>
        <option value="">Please select</option>
        <option value="yes">Yes, I require sponsorship</option>
        <option value="no">No, I am already authorized without sponsorship</option>
      </select>
    </div>
    <div>
      <label for="custom_stack">Which orchestration framework have you used in production? *</label>
      <input id="custom_stack" name="custom_stack" type="text" required />
    </div>
    <div>
      <input id="gdpr_consent" name="gdpr_consent" type="checkbox" required />
      <label for="gdpr_consent">I agree to the privacy policy and data processing terms *</label>
    </div>
    <button type="submit">Submit Application</button>
  </form>
  <div id="confirmation" style="display:none">
    <h2>Thank you! Your application has been submitted.</h2>
  </div>
  <script>
    document.getElementById('application-form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.getElementById('application-form').style.display = 'none';
      document.getElementById('confirmation').style.display = 'block';
    });
  </script>
</body>
</html>`;

describe("form-scraper & form-runner end-to-end with Playwright Chromium", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;
  let resumePdfPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-form-runner-"));
    resumePdfPath = path.join(tmpDir, "pushkar-cv.pdf");
    await fs.writeFile(resumePdfPath, Buffer.from("%PDF-1.4 dummy cv payload"));

    const profilePath = path.join(tmpDir, "apply-profile.json");
    process.env["APPLY_PROFILE_PATH"] = profilePath;
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        first_name: "Pushkar",
        last_name: "Verma",
        email: "pushkar3698@gmail.com",
        phone: "+31 6 12345678",
        default_resume: resumePdfPath,
        answers: {
          work_authorization: "requires-sponsorship",
          auto_consent: true,
        },
      }),
    );

    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FORM_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/apply`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("classifies supported ATS URLs and rejects unsupported login-walled aggregators", () => {
    expect(classifyFormUrl("https://job-boards.eu.greenhouse.io/workwize/jobs/123")).toEqual({
      supported: true,
      platform: "greenhouse",
    });
    expect(classifyFormUrl("https://jobs.ashbyhq.com/linear/abc")).toEqual({
      supported: true,
      platform: "ashby",
    });
    expect(resolveFormTargetUrl("https://jobs.ashbyhq.com/linear/abc", "Linear", "ashby")).toBe(
      "https://jobs.ashbyhq.com/linear/abc/application",
    );
    expect(classifyFormUrl("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123").supported).toBe(false);
  });

  it("fills known fields, flags unknown required question, learns answer into dossier, and submits end-to-end", async () => {
    const parsed = parseApplyProfile(await fs.readFile(process.env["APPLY_PROFILE_PATH"]!, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const initialDossier = parseDossierMarkdown("# Candidate Reference Dossier\n");

    // 1. First pass: prepare form before custom question is known
    let prep1;
    try {
      prep1 = await prepareApplicationForm(
        baseUrl,
        "Acme AI",
        parsed.profile,
        { resumePath: resumePdfPath },
        initialDossier,
      );
    } catch (err) {
      if ((err as Error).message.includes("Executable doesn't exist")) {
        return; // Bare CI container without Playwright or system Chrome binary
      }
      throw err;
    }
    expect(prep1.ok).toBe(true);
    if (!prep1.ok) return;

    expect(prep1.summary.filled).toBe(7); // first_name, last_name, email, phone, resume, sponsorship, gdpr_consent
    expect(prep1.summary.unanswered).toHaveLength(1);
    expect(prep1.summary.unanswered[0]?.label).toContain("Which orchestration framework");
    expect(prep1.screenshotPng.length).toBeGreaterThan(1000);

    // 2. ADR-018 safety: attempting to submit while a required field is unanswered is refused
    const refused = await submitApplicationForm(
      baseUrl,
      "Acme AI",
      parsed.profile,
      { resumePath: resumePdfPath },
      initialDossier,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("refusing to click submit while required fields are unanswered");
    }

    // 3. Candidate replies in Telegram -> saved to dossier & question bank
    await recordLearnedAnswer(
      "pushkar-nl-tech",
      "Which orchestration framework have you used in production? *",
      "LangGraph and Playwright",
    );

    const reloadedProfile = parseApplyProfile(await fs.readFile(process.env["APPLY_PROFILE_PATH"]!, "utf8"));
    expect(reloadedProfile.ok).toBe(true);
    if (!reloadedProfile.ok) return;
    const reloadedDossier = (await readCandidateDossier("pushkar-nl-tech")) ?? undefined;

    // 4. Submit with learned answer: fills 8/8 fields, passes checkValidity(), clicks submit, confirms banner
    const submitted = await submitApplicationForm(
      baseUrl,
      "Acme AI",
      reloadedProfile.profile,
      { resumePath: resumePdfPath },
      reloadedDossier,
    );
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    expect(submitted.clicked).toBe(true);
    expect(submitted.confirmed).toBe(true);
    expect(submitted.afterScreenshotPng.length).toBeGreaterThan(1000);
  }, 30_000);
});
