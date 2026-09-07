/**
 * The planner routes on the DEPARTMENT description, not on the tool schema.
 *
 * MEASURED IN PROD over real Telegram, 2026-09-07. Asked "What is Tashi CV
 * background and what jobs is she looking for?", the planner picked `personal`
 * — whose toolbox holds `search_personal_rag` and `list_dir` and NOT `read_cv`
 * — searched the founder's own knowledge base, found nothing about her, and
 * replied "CV Background: Missing" about a file that exists on disk at
 * /opt/founderos-data/cv/cv-wife-base.md.
 *
 * Three layers had to be right and only two were: `read_cv` accepts a
 * profileId (fixed 2026-09-06), its description names both candidates (fixed
 * earlier the same day) — but the department that OWNS that tool never got the
 * turn, so neither fix could run. A question about a person reads as
 * "personal" unless the jobhunt department claims it by name.
 */

import { describe, it, expect } from "vitest";
import { DESCRIPTIONS } from "../../../src/gateway/kernel-boot.js";

describe("jobhunt department routing description", () => {
  it("claims CV questions for the second candidate by name", () => {
    expect(DESCRIPTIONS.jobhunt).toMatch(/tashi/i);
  });

  it("claims CV content questions, not only 'CV work'", () => {
    // "CV/resume work" alone lost the routing contest. The description has to
    // name what the founder actually asks about.
    expect(DESCRIPTIONS.jobhunt).toMatch(/work history|education|employers/i);
  });

  it("still scopes personal to the machine, so the two do not compete", () => {
    expect(DESCRIPTIONS.personal).not.toMatch(/tashi/i);
    expect(DESCRIPTIONS.personal).toMatch(/files|directories|shell|laptop/i);
  });
});
