/**
 * recordLearnedAnswer: a newer answer replaces older spellings of the same question
 * =================================================================================
 * explicitAnswerFor returns the FIRST question_bank entry whose normalised key matches, so an older
 * entry spelled "Location (City)" would keep beating a newer answer recorded as "Location (City)*"
 * (the apply answer page records under the label as the form shows it). Recording a question now drops
 * the other entries that normalise to the same key and leaves every unrelated entry alone.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProfilePathFor } from "../../../src/tools/jobhunt/apply-profile.js";
import { recordLearnedAnswer } from "../../../src/tools/jobhunt/candidate-dossier.js";

const PROFILE_ID = "fixture-profile";

describe("recordLearnedAnswer question_bank", () => {
  let dir: string;
  let prevPath: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-record-"));
    prevPath = process.env["APPLY_PROFILE_PATH"];
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
  });

  afterEach(async () => {
    if (prevPath === undefined) delete process.env["APPLY_PROFILE_PATH"];
    else process.env["APPLY_PROFILE_PATH"] = prevPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed(bank: Record<string, string>): Promise<void> {
    const raw = { first_name: "Fixture", last_name: "Person", email: "fixture@example.com", phone: "+31 6 00000000", question_bank: bank };
    await fs.writeFile(applyProfilePathFor(PROFILE_ID), JSON.stringify(raw, null, 2));
  }

  async function bank(): Promise<Record<string, string>> {
    const raw = JSON.parse(await fs.readFile(applyProfilePathFor(PROFILE_ID), "utf8")) as { question_bank: Record<string, string> };
    return raw.question_bank;
  }

  it("replaces an older entry for the same question spelled differently", async () => {
    await seed({ "Location (City)": "Old Town", "Notice period": "30 days" });
    await recordLearnedAnswer(PROFILE_ID, "Location (City)*", "Utrecht");
    expect(await bank()).toEqual({ "Notice period": "30 days", "Location (City)*": "Utrecht" });
  });

  it("keeps one entry when the same question is recorded twice", async () => {
    await seed({});
    await recordLearnedAnswer(PROFILE_ID, "Location (City)*", "Utrecht");
    await recordLearnedAnswer(PROFILE_ID, "Location (City)*", "Rotterdam");
    expect(await bank()).toEqual({ "Location (City)*": "Rotterdam" });
  });

  it("leaves unrelated entries alone, including a question that only shares words", async () => {
    await seed({ "Location (Country)": "Netherlands", "City of birth": "Delhi" });
    await recordLearnedAnswer(PROFILE_ID, "Location (City)*", "Utrecht");
    expect(await bank()).toEqual({ "Location (Country)": "Netherlands", "City of birth": "Delhi", "Location (City)*": "Utrecht" });
  });

  it("does not treat a label that normalises to nothing as a match for other junk entries", async () => {
    await seed({ "???": "kept", "Notice period": "30 days" });
    await recordLearnedAnswer(PROFILE_ID, "***", "x");
    expect(await bank()).toEqual({ "???": "kept", "Notice period": "30 days", "***": "x" });
  });
});
