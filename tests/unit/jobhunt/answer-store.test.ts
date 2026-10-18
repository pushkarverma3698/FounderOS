/**
 * Answer store: atomic writes, backups, restore, Core Facts sync.
 * An edit to answers.salary_floor_eur_year must reach what a form reads (the dossier Core Facts line).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleProfile } from "../../../src/gateway/profile-commands.js";
import {
  BACKUPS_KEPT,
  atomicWrite,
  backupAnswerFiles,
  deleteLearnedAnswer,
  listAnswerBackups,
  listLearnedAnswers,
  recordLearnedAnswer,
  restoreAnswerBackup,
  saveAnswers,
  setCoreAnswer,
  upsertLearnedAnswer,
} from "../../../src/tools/jobhunt/answer-store.js";
import { applyProfilePathFor, parseApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import {
  buildDefaultDossierMarkdown,
  candidateDossierPathFor,
  explicitAnswerFor,
  lookupLearnedAnswer,
  parseDossierMarkdown,
  readCandidateDossier,
  writeCandidateDossier,
} from "../../../src/tools/jobhunt/candidate-dossier.js";
import { DEFAULT_PROFILE_ID } from "../../../src/tools/jobhunt/profile-config.js";

const WIFE = "tashi-nl";

const base = {
  first_name: "Fixture",
  last_name: "Person",
  email: "fixture@example.com",
  phone: "+31 6 00000000",
  answers: { work_authorization: "unknown", salary_floor_eur_year: 60000, notice_period_days: 30, willing_to_relocate: true },
};

describe("answer store", () => {
  let dir: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-answer-store-"));
    for (const k of ["APPLY_PROFILE_PATH", "FOUNDEROS_DATA_ROOT"]) prev[k] = process.env[k];
    process.env["FOUNDEROS_DATA_ROOT"] = dir;
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed(profileId: string, extra: Record<string, unknown> = {}): Promise<void> {
    const raw = { ...base, ...extra };
    await fs.writeFile(applyProfilePathFor(profileId), JSON.stringify(raw, null, 2));
    const parsed = parseApplyProfile(JSON.stringify(raw));
    if (!parsed.ok) throw new Error(parsed.reason);
    await writeCandidateDossier(profileId, buildDefaultDossierMarkdown(parsed.profile));
  }
  const readJson = async (id: string): Promise<Record<string, any>> =>
    JSON.parse(await fs.readFile(applyProfilePathFor(id), "utf8"));
  const readMd = (id: string): Promise<string> => fs.readFile(candidateDossierPathFor(id), "utf8");
  const tmps = async (): Promise<string[]> => (await fs.readdir(dir)).filter((n) => n.includes(".tmp-"));

  it("atomicWrite leaves no partial or temp file when the rename fails", async () => {
    const target = path.join(dir, "target");
    await fs.mkdir(target);
    await expect(atomicWrite(target, "new content")).rejects.toThrow();
    expect(await tmps()).toEqual([]);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it("atomicWrite replaces the file whole, mode 0600", async () => {
    const file = path.join(dir, "f.json");
    await atomicWrite(file, "old");
    await atomicWrite(file, "new");
    expect(await fs.readFile(file, "utf8")).toBe("new");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await tmps()).toEqual([]);
  });

  it("keeps only the newest 30 backup pairs", async () => {
    await seed(DEFAULT_PROFILE_ID);
    const stamps: string[] = [];
    for (let i = 0; i < 35; i++) stamps.push((await backupAnswerFiles(DEFAULT_PROFILE_ID))!);
    const left = await listAnswerBackups(DEFAULT_PROFILE_ID);
    expect(BACKUPS_KEPT).toBe(30);
    expect(left).toHaveLength(30);
    expect(left.map((b) => b.ts)).toEqual([...stamps].reverse().slice(0, 30));
    expect(left.every((b) => b.json && b.md)).toBe(true);
    const bdir = path.join(dir, "answer-backups", DEFAULT_PROFILE_ID);
    const files = await fs.readdir(bdir);
    expect(files).toHaveLength(60);
    expect((await fs.stat(path.join(bdir, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it("restores both files from a backup and backs up what it replaced", async () => {
    await seed(DEFAULT_PROFILE_ID);
    const ts = (await backupAnswerFiles(DEFAULT_PROFILE_ID))!;
    await setCoreAnswer(DEFAULT_PROFILE_ID, "salary_floor_eur_year", "99000");
    expect((await readJson(DEFAULT_PROFILE_ID))["answers"]["salary_floor_eur_year"]).toBe(99000);
    const before = (await listAnswerBackups(DEFAULT_PROFILE_ID)).length;

    expect(await restoreAnswerBackup(DEFAULT_PROFILE_ID, ts)).toEqual({ ok: true });
    expect((await readJson(DEFAULT_PROFILE_ID))["answers"]["salary_floor_eur_year"]).toBe(60000);
    expect(await readMd(DEFAULT_PROFILE_ID)).toContain("**Salary Expectation**: 60000");
    expect((await listAnswerBackups(DEFAULT_PROFILE_ID)).length).toBe(before + 1);
  });

  it("refuses to restore an invalid profile backup, and a bad timestamp", async () => {
    await seed(DEFAULT_PROFILE_ID);
    const ts = (await backupAnswerFiles(DEFAULT_PROFILE_ID))!;
    await fs.writeFile(path.join(dir, "answer-backups", DEFAULT_PROFILE_ID, `${ts}.json`), "{ not json");
    const live = await fs.readFile(applyProfilePathFor(DEFAULT_PROFILE_ID), "utf8");
    expect((await restoreAnswerBackup(DEFAULT_PROFILE_ID, ts)).ok).toBe(false);
    expect((await restoreAnswerBackup(DEFAULT_PROFILE_ID, "not-a-timestamp")).ok).toBe(false);
    expect(await fs.readFile(applyProfilePathFor(DEFAULT_PROFILE_ID), "utf8")).toBe(live);
  });

  it("upsert keeps one entry per question, newest last, in both files", async () => {
    await seed(DEFAULT_PROFILE_ID, { question_bank: { "Location (City)": "Old Town", "Notice period": "30 days" } });
    await upsertLearnedAnswer(DEFAULT_PROFILE_ID, "Location (City)*", "Utrecht");
    const bank = (await readJson(DEFAULT_PROFILE_ID))["question_bank"];
    expect(Object.entries(bank)).toEqual([["Notice period", "30 days"], ["Location (City)*", "Utrecht"]]);
    const md = await readMd(DEFAULT_PROFILE_ID);
    expect(md.match(/Location \(City\)/g)).toHaveLength(1);
    expect(md.trimEnd().endsWith("Utrecht")).toBe(true);
    const listed = await listLearnedAnswers(DEFAULT_PROFILE_ID);
    expect(listed.at(-1)).toEqual({ question: "Location (City)*", answer: "Utrecht", source: "both" });
  });

  it("an EEO answer also sets the self_identification category", async () => {
    await seed(DEFAULT_PROFILE_ID);
    await upsertLearnedAnswer(DEFAULT_PROFILE_ID, "Gender", "Male");
    expect((await readJson(DEFAULT_PROFILE_ID))["answers"]["self_identification"]).toBeDefined();
  });

  it("delete removes the answer from question_bank AND the dossier, and reports a miss", async () => {
    await seed(DEFAULT_PROFILE_ID);
    await recordLearnedAnswer(DEFAULT_PROFILE_ID, "Favourite colour", "Green");
    await upsertLearnedAnswer(DEFAULT_PROFILE_ID, "Pet name", "Rex");
    expect((await listLearnedAnswers(DEFAULT_PROFILE_ID)).map((l) => l.question)).toEqual(["Favourite colour", "Pet name"]);

    const r = await deleteLearnedAnswer(DEFAULT_PROFILE_ID, "favourite colour");
    expect(r).toMatchObject({ ok: true, changed: true });
    expect((await readJson(DEFAULT_PROFILE_ID))["question_bank"]).toEqual({ "Pet name": "Rex" });
    expect(await readMd(DEFAULT_PROFILE_ID)).not.toContain("Favourite colour");
    expect(await readMd(DEFAULT_PROFILE_ID)).toContain("Pet name");
    expect(await deleteLearnedAnswer(DEFAULT_PROFILE_ID, "never asked")).toMatchObject({ ok: true, changed: false });
  });

  it("recordLearnedAnswer backs up at most once per 10 minutes", async () => {
    await seed(DEFAULT_PROFILE_ID);
    for (let i = 0; i < 5; i++) await recordLearnedAnswer(DEFAULT_PROFILE_ID, `Question ${i}`, `Answer ${i}`);
    expect(await listAnswerBackups(DEFAULT_PROFILE_ID)).toHaveLength(1);
  });

  it("saveAnswers refuses an invalid result and writes nothing", async () => {
    await seed(DEFAULT_PROFILE_ID);
    const live = await fs.readFile(applyProfilePathFor(DEFAULT_PROFILE_ID), "utf8");
    const r = await saveAnswers(DEFAULT_PROFILE_ID, (s) => ({
      profile: { ...s.profile, email: "nonsense" },
      dossierMarkdown: s.dossierMarkdown,
    }));
    expect(r.ok).toBe(false);
    expect(await fs.readFile(applyProfilePathFor(DEFAULT_PROFILE_ID), "utf8")).toBe(live);
    expect(await listAnswerBackups(DEFAULT_PROFILE_ID)).toEqual([]);
  });

  it("Core Facts follow answers.*: salary, notice period and relocation reach the form lookup", async () => {
    await seed(DEFAULT_PROFILE_ID);
    await setCoreAnswer(DEFAULT_PROFILE_ID, "salary_floor_eur_year", "70000");
    await setCoreAnswer(DEFAULT_PROFILE_ID, "notice_period_days", "60");
    await setCoreAnswer(DEFAULT_PROFILE_ID, "willing_to_relocate", "false");
    const profile = parseApplyProfile(await fs.readFile(applyProfilePathFor(DEFAULT_PROFILE_ID), "utf8"));
    if (!profile.ok) throw new Error(profile.reason);
    const dossier = (await readCandidateDossier(DEFAULT_PROFILE_ID))!;
    expect(lookupLearnedAnswer("Salary expectation", undefined, profile.profile, dossier)?.value).toBe("70000");
    expect(explicitAnswerFor("Salary expectation", profile.profile, dossier)?.value).toBe("70000");
    expect(lookupLearnedAnswer("Notice period", undefined, profile.profile, dossier)?.value).toBe("60 days");
    expect(lookupLearnedAnswer("Are you willing to relocate", undefined, profile.profile, dossier)?.value).toBe("No");
    expect((await readMd(DEFAULT_PROFILE_ID)).match(/Salary Expectation/g)).toHaveLength(1);
  });

  it("adds a missing Core Facts line, and leaves an unrelated hand-written fact alone", async () => {
    await seed(DEFAULT_PROFILE_ID);
    await writeCandidateDossier(
      DEFAULT_PROFILE_ID,
      "# Dossier\n\n## Core Facts\n- **Email**: fixture@example.com\n- **Hobby**: chess\n\n## Learned Form Answers\n",
    );
    await setCoreAnswer(DEFAULT_PROFILE_ID, "salary_floor_eur_year", "70000");
    const facts = parseDossierMarkdown(await readMd(DEFAULT_PROFILE_ID)).facts;
    expect(facts["salary expectation"]).toBe("70000");
    expect(facts["hobby"]).toBe("chess");
  });

  it("BUG REPRO: /profile set answers.salary_floor_eur_year reaches the dossier fact a form reads", async () => {
    await seed(DEFAULT_PROFILE_ID);
    const replies: string[] = [];
    const ctx = { match: "set answers.salary_floor_eur_year 70000", reply: async (t: string) => void replies.push(t) };
    await handleProfile(ctx as never);
    expect(replies.join("\n")).toContain("is now");
    const profile = parseApplyProfile(await fs.readFile(applyProfilePathFor(DEFAULT_PROFILE_ID), "utf8"));
    if (!profile.ok) throw new Error(profile.reason);
    const dossier = (await readCandidateDossier(DEFAULT_PROFILE_ID))!;
    expect(lookupLearnedAnswer("Salary expectation", undefined, profile.profile, dossier)?.value).toBe("70000");
  });

  it("a second candidate is untouched, and backups are kept apart", async () => {
    await seed(DEFAULT_PROFILE_ID);
    await seed(WIFE, { first_name: "Tashi", email: "tashi@example.com" });
    const wifeJson = await fs.readFile(applyProfilePathFor(WIFE), "utf8");
    const wifeMd = await readMd(WIFE);

    await setCoreAnswer(DEFAULT_PROFILE_ID, "salary_floor_eur_year", "70000");
    await upsertLearnedAnswer(DEFAULT_PROFILE_ID, "Pet name", "Rex");
    await deleteLearnedAnswer(DEFAULT_PROFILE_ID, "Pet name");

    expect(await fs.readFile(applyProfilePathFor(WIFE), "utf8")).toBe(wifeJson);
    expect(await readMd(WIFE)).toBe(wifeMd);
    expect(await listAnswerBackups(WIFE)).toEqual([]);
    expect((await listAnswerBackups(DEFAULT_PROFILE_ID)).length).toBeGreaterThan(0);
  });
});
