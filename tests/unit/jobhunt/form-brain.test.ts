import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import {
  buildDefaultDossierMarkdown,
  lookupLearnedAnswer,
  matchChoiceOption,
  normalizeQuestionKey,
  parseDossierMarkdown,
  recordLearnedAnswer,
} from "../../../src/tools/jobhunt/candidate-dossier.js";
import {
  buildFormFillPlan,
  chooseEligibility,
  ELIGIBILITY_CONFIDENCE_FLOOR,
  scoreEligibilityOption,
  summariseFormPlan,
  type ScrapedField,
} from "../../../src/tools/jobhunt/form-brain.js";

const PUSHKAR_PROFILE: ApplyProfile = {
  first_name: "Pushkar",
  last_name: "Verma",
  email: "pushkar3698@gmail.com",
  phone: "+91 97792 60517",
  linkedin: "https://www.linkedin.com/in/pushkar-verma-809155234",
  website: "https://github.com/pushkarverma3698",
  answers: {
    location_city: "Mohali",
    location_country: "India",
    work_authorization: "requires-sponsorship",
    salary_floor_eur_year: 52284,
    years_experience: 3.5,
    notice_period_days: 0,
    needs_relocation: true,
    willing_to_relocate: true,
  },
};

const TASHI_PROFILE: ApplyProfile = {
  first_name: "Tashi",
  last_name: "Goyal",
  email: "goyaltashi7@gmail.com",
  phone: "+31-616527081",
  linkedin: "linkedin.com/in/tashi-goyal",
  answers: {
    location_city: "Amsterdam",
    location_country: "Netherlands",
    work_authorization: "authorized-no-sponsorship",
    years_experience: 2.4,
    notice_period_days: 30,
  },
};

describe("candidate-dossier", () => {
  it("normalises question keys stripping required markers and punctuation", () => {
    expect(normalizeQuestionKey("What is your notice period? * (Required)")).toBe(
      "what is your notice period",
    );
    expect(normalizeQuestionKey("Wat is je opzegtermijn? (verplicht)")).toBe(
      "wat is je opzegtermijn",
    );
  });

  it("matches choice options unambiguously and returns null when ambiguous", () => {
    expect(matchChoiceOption("Yes", ["Please select", "Yes, I agree", "No"])).toBe("Yes, I agree");
    expect(matchChoiceOption("No", ["Ja", "Nee"])).toBe("Nee");
    expect(matchChoiceOption("LinkedIn", ["Company Website", "LinkedIn Job Board", "Referral"])).toBe(
      "LinkedIn Job Board",
    );
    // True negative: two options both contain "Netherlands" — refuses to guess
    expect(
      matchChoiceOption("Netherlands", [
        "Netherlands — already authorized",
        "Netherlands — requires sponsorship",
      ]),
    ).toBeNull();
  });

  it("parses facts and Q&A pairs from a candidate reference dossier markdown", () => {
    const md = [
      "# Pushkar Verma — Candidate Reference Dossier",
      "",
      "## Core Facts",
      "- **Current Company**: Turicks",
      "- **Current Title**: AI Engineer",
      "- **Highest Degree**: B.Tech Computer Science",
      "- **Referral Source**: LinkedIn",
      "",
      "## Learned Form Answers",
      "Q: Are you comfortable working in an Amsterdam hybrid setup (3 days/week)?",
      "A: Yes",
      "- **Do you have experience with PostgreSQL in production?**: Yes, 3.5 years in production",
    ].join("\n");

    const dossier = parseDossierMarkdown(md);
    expect(dossier.facts["current company"]).toBe("Turicks");
    expect(dossier.facts["current title"]).toBe("AI Engineer");

    const hybrid = lookupLearnedAnswer(
      "Are you comfortable working in an Amsterdam hybrid setup (3 days/week)? *",
      ["Yes", "No"],
      PUSHKAR_PROFILE,
      dossier,
    );
    expect(hybrid).toEqual({
      kind: "choose",
      value: "Yes",
      source: expect.stringContaining("dossier Q&A"),
    });

    const company = lookupLearnedAnswer("What is your current employer?", undefined, PUSHKAR_PROFILE, dossier);
    expect(company).toEqual({
      kind: "value",
      value: "Turicks",
      source: "dossier/profile rule (currentCompany)",
    });

    // True negative: an unknown custom question not in dossier or profile returns null
    expect(
      lookupLearnedAnswer("What is your favourite security conference?", undefined, PUSHKAR_PROFILE, dossier),
    ).toBeNull();
  });

  it("persists learned answers to both apply-profile JSON and candidate-dossier Markdown", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dossier-test-"));
    const prevProfilePath = process.env["APPLY_PROFILE_PATH"];
    try {
      const profilePath = path.join(tmpDir, "apply-profile.json");
      await fs.writeFile(profilePath, JSON.stringify(PUSHKAR_PROFILE, null, 2));
      const { writeApplyProfile, readApplyProfile } = await import("../../../src/tools/jobhunt/apply-profile.js");
      await writeApplyProfile(PUSHKAR_PROFILE as unknown as Record<string, unknown>, profilePath);

      const starterMd = buildDefaultDossierMarkdown(PUSHKAR_PROFILE);
      expect(starterMd).toContain("Pushkar Verma");

      // Test recordLearnedAnswer against a custom profile path by setting APPLY_PROFILE_PATH
      process.env["APPLY_PROFILE_PATH"] = profilePath;
      await recordLearnedAnswer("alex-de-tech", "What is your German level?", "B1");
      const savedMd = await fs.readFile(path.join(tmpDir, "candidate-dossier-alex-de-tech.md"), "utf8");
      expect(savedMd).toContain("- **What is your German level?**: B1");
      const readBack = await readApplyProfile(profilePath);
      expect(readBack.ok).toBe(true);
    } finally {
      if (prevProfilePath === undefined) delete process.env["APPLY_PROFILE_PATH"];
      else process.env["APPLY_PROFILE_PATH"] = prevProfilePath;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("form-brain", () => {
  it("fills standard English & Dutch fields, dossier answers, and leaves unknown questions as ask", () => {
    const dossier = parseDossierMarkdown(
      "- **Current Company**: Turicks\n- **How did you hear about us?**: LinkedIn\n",
    );
    const fields: ScrapedField[] = [
      { selector: "#voornaam", type: "text", label: "Voornaam *", required: true },
      { selector: "#achternaam", type: "text", label: "Achternaam *", required: true },
      { selector: "#email", type: "email", label: "E-mailadres *", required: true },
      { selector: "#phone", type: "tel", label: "Telefoonnummer *", required: true },
      { selector: "#cv", type: "file", label: "CV *", required: true },
      { selector: "#notice", type: "text", label: "Wat is je opzegtermijn?", required: true },
      {
        selector: "#source",
        type: "select",
        label: "How did you hear about us?",
        required: false,
        options: ["Please select", "LinkedIn", "Referral"],
      },
      { selector: "#captcha", type: "captcha", label: "reCAPTCHA", required: true, isCaptcha: true },
      { selector: "#gdpr", type: "checkbox", label: "I agree to the privacy policy", required: true, isConsent: true },
      { selector: "#custom_q", type: "textarea", label: "Describe a time you debugged a race condition", required: true },
    ];

    const plan = buildFormFillPlan(
      fields,
      PUSHKAR_PROFILE,
      { resumePath: "/tmp/cv-pushkar.pdf" },
      dossier,
    );

    const summary = summariseFormPlan(plan, fields);
    expect(summary.hasCaptcha).toBe(true);
    expect(summary.filled).toBe(7);
    expect(summary.unanswered.map((u) => u.selector)).toEqual(["#gdpr", "#custom_q"]);
  });

  it("handles eligibility questions accurately for both requires-sponsorship (Pushkar) and authorized-no-sponsorship (Tashi)", () => {
    const ghEligibility: ScrapedField = {
      selector: 'input[name="work_auth"]',
      type: "radio-group",
      label: "Do you require visa sponsorship to work in the Netherlands?",
      required: true,
      options: ["Yes", "No"],
      isEligibility: true,
    };

    const pushkarChoice = chooseEligibility(ghEligibility, PUSHKAR_PROFILE);
    expect(pushkarChoice.kind).toBe("choose");
    if (pushkarChoice.kind === "choose") {
      expect(pushkarChoice.option).toBe("Yes");
      expect(pushkarChoice.confidence).toBeGreaterThanOrEqual(ELIGIBILITY_CONFIDENCE_FLOOR);
    }

    const tashiChoice = chooseEligibility(ghEligibility, TASHI_PROFILE);
    expect(tashiChoice.kind).toBe("choose");
    if (tashiChoice.kind === "choose") {
      expect(tashiChoice.option).toBe("No");
    }

    // True negative: when work_authorization is "unknown", chooseEligibility MUST return ask, never guess
    const unknownProfile: ApplyProfile = {
      ...PUSHKAR_PROFILE,
      answers: { work_authorization: "unknown" },
    };
    expect(chooseEligibility(ghEligibility, unknownProfile).kind).toBe("ask");
    expect(scoreEligibilityOption("Need sponsorship", "requires-sponsorship")).toBeGreaterThan(0.9);
  });

  it("answers Ashby's 'Do you require a visa to legally work…' Yes/No from work_authorization", () => {
    // Real Mollie (Ashby) label, scraped 2026-10-17; the scraper does not flag it as eligibility.
    const visa: ScrapedField = {
      selector: '[name="c384b593-fe20-4f59-bae8-1c83f7451920"]',
      type: "radio-group",
      label: "Do you require a visa to legally work in the country where you are applying?",
      required: true,
      options: ["Yes", "No"],
    };
    const tashi = buildFormFillPlan([visa], TASHI_PROFILE)[0]!;
    expect(tashi.kind).toBe("choose");
    if (tashi.kind === "choose") expect(tashi.option).toBe("No");
    const pushkar = buildFormFillPlan([visa], PUSHKAR_PROFILE)[0]!;
    expect(pushkar.kind).toBe("choose");
    if (pushkar.kind === "choose") expect(pushkar.option).toBe("Yes");
  });
});
