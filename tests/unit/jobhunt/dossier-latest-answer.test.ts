/**
 * Stored answers: the latest one wins, and two stores that disagree make the bot ask
 * ==================================================================================
 * The 2026-10-17 QA run found the candidate dossier holding two different answers to the same
 * question ("Are you based in The Netherlands or Ireland?*"), so the filled answer depended on which
 * entry won. Three fixes, each pinned here:
 *  1. The dossier parser reads `- **Label?***: answer` lines (a label ending in `*` used to fail to
 *     parse), and a later line for the same question beats an earlier one.
 *  2. Within question_bank the last entry for a normalised question wins.
 *  3. When question_bank and the dossier still disagree, the form asks instead of picking one.
 * recordLearnedAnswer now replaces the older learned line instead of appending a second one, and
 * stores an answer to a self-identification question as `answers.self_identification.<category>`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProfilePathFor, type ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import {
  candidateDossierPathFor,
  explicitAnswerFor,
  parseDossierMarkdown,
  recordLearnedAnswer,
} from "../../../src/tools/jobhunt/candidate-dossier.js";
import { buildFormFillPlan, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";

const NL_Q = "Are you based in The Netherlands or Ireland?*";
const NL_KEY = "are you based in the netherlands or ireland";

const BASE: ApplyProfile = {
  first_name: "Fixture",
  last_name: "Person",
  email: "fixture@example.com",
  phone: "+31 6 00000000",
  answers: { work_authorization: "authorized-no-sponsorship" },
};

const DUPLICATED = [
  "# Candidate Reference Dossier — Fixture Person",
  "",
  "## Learned Form Answers",
  `- **${NL_Q}**: No`,
  "- **Veteran Status**: Option A",
  "- **OFAC: are you a resident of a sanctioned region?**: No",
  `- **${NL_Q}**: Yes`,
  "- **Veteran Status**: Option B",
  "",
].join("\n");

const nlSelect: ScrapedField = { selector: "#nl", type: "select", label: NL_Q, required: true, options: ["Yes", "No"] };

describe("dossier parsing", () => {
  it("parses labels ending in `*` and keeps the latest line for a repeated question", () => {
    const d = parseDossierMarkdown(DUPLICATED);
    expect(d.qaPairs[NL_KEY]).toBe("Yes");
    expect(d.qaPairs["veteran status"]).toBe("Option B");
  });

  it("parses a bold label that contains a colon", () => {
    const d = parseDossierMarkdown(DUPLICATED);
    expect(d.qaPairs["ofac are you a resident of a sanctioned region"]).toBe("No");
  });
});

describe("question_bank latest entry", () => {
  it("takes the last entry when two spellings of a question are stored", () => {
    const profile: ApplyProfile = { ...BASE, question_bank: { "Are you based in The Netherlands or Ireland?": "No", [NL_Q]: "Yes" } };
    expect(explicitAnswerFor(NL_Q, profile)?.value).toBe("Yes");
  });
});

describe("question_bank vs dossier", () => {
  it("asks when the two hold different answers", () => {
    const profile: ApplyProfile = { ...BASE, question_bank: { [NL_Q]: "No" } };
    const [action] = buildFormFillPlan([nlSelect], profile, {}, parseDossierMarkdown(DUPLICATED));
    expect(action?.kind).toBe("ask");
    expect(action?.why).toMatch(/different answers/);
  });

  it("fills when the two agree", () => {
    const profile: ApplyProfile = { ...BASE, question_bank: { [NL_Q]: "Yes" } };
    const [action] = buildFormFillPlan([nlSelect], profile, {}, parseDossierMarkdown(DUPLICATED));
    expect(action).toMatchObject({ kind: "choose", option: "Yes" });
  });

  it("treats a multi-line answer as agreeing with its one-line dossier entry", () => {
    const profile: ApplyProfile = { ...BASE, question_bank: { "Why us?": "First line.\nSecond line." } };
    const dossier = parseDossierMarkdown("## Learned Form Answers\n- **Why us?**: First line.\n");
    const field: ScrapedField = { selector: "#why", type: "textarea", label: "Why us?", required: true };
    const [action] = buildFormFillPlan([field], profile, {}, dossier);
    expect(action).toMatchObject({ kind: "value", value: "First line.\nSecond line." });
  });
});

describe("recordLearnedAnswer", () => {
  const PROFILE_ID = "fixture-profile";
  let dir: string;
  let prevPath: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-latest-"));
    prevPath = process.env["APPLY_PROFILE_PATH"];
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
    const raw = { ...BASE, question_bank: { [NL_Q]: "Yes" } };
    await fs.writeFile(applyProfilePathFor(PROFILE_ID), JSON.stringify(raw, null, 2));
    await fs.writeFile(candidateDossierPathFor(PROFILE_ID), DUPLICATED);
  });

  afterEach(async () => {
    if (prevPath === undefined) delete process.env["APPLY_PROFILE_PATH"];
    else process.env["APPLY_PROFILE_PATH"] = prevPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const dossierText = (): Promise<string> => fs.readFile(candidateDossierPathFor(PROFILE_ID), "utf8");
  const profileRaw = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(applyProfilePathFor(PROFILE_ID), "utf8")) as Record<string, unknown>;

  it("replaces every older learned line for the question with one line at the end", async () => {
    await recordLearnedAnswer(PROFILE_ID, "Are you based in the Netherlands or Ireland?", "No");
    const text = await dossierText();
    const nlLines = text.split("\n").filter((l) => l.toLowerCase().includes("netherlands or ireland"));
    expect(nlLines).toEqual(["- **Are you based in the Netherlands or Ireland?**: No"]);
    expect(text.trimEnd().endsWith(nlLines[0]!)).toBe(true);
    expect(text).toContain("- **Veteran Status**: Option B");
    expect(text).toContain("- **OFAC: are you a resident of a sanctioned region?**: No");
    expect(parseDossierMarkdown(text).qaPairs[NL_KEY]).toBe("No");
  });

  it("stores an answer to a self-identification question as answers.self_identification", async () => {
    await recordLearnedAnswer(PROFILE_ID, "Veteran Status", "Option C");
    const raw = await profileRaw();
    expect((raw["answers"] as Record<string, unknown>)["self_identification"]).toEqual({ veteran: "Option C" });
    expect((raw["answers"] as Record<string, unknown>)["work_authorization"]).toBe("authorized-no-sponsorship");
    expect(raw["question_bank"]).toEqual({ [NL_Q]: "Yes", "Veteran Status": "Option C" });
    const veteranLines = (await dossierText()).split("\n").filter((l) => l.includes("Veteran Status"));
    expect(veteranLines).toEqual(["- **Veteran Status**: Option C"]);
  });

  it("leaves answers alone for a question that is not self-identification", async () => {
    await recordLearnedAnswer(PROFILE_ID, NL_Q, "No");
    const raw = await profileRaw();
    expect((raw["answers"] as Record<string, unknown>)["self_identification"]).toBeUndefined();
  });
});
