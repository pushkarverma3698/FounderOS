import { describe, expect, it } from "vitest";
import { answerSourceOf, isTrustedAnswer } from "../../../src/tools/jobhunt/answer-source.js";
import {
  autoSendEnvOn, canAutoSend, dailyCapFrom, letterIsRequired, type AutoSendHistory, type AutoSendLimits, type AutoSendVerdict,
} from "../../../src/tools/jobhunt/auto-send-rules.js";
import type { FilledAnswer, FormPlanSummary, UnansweredQuestion } from "../../../src/tools/jobhunt/form-filled.js";

const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const filled = (label: string, source: FilledAnswer["source"], confidence = 1): FilledAnswer => ({ label, value: "v", fieldType: "text", editable: true, source, confidence });
const ask = (label: string): UnansweredQuestion => ({ selector: "#x", label, kind: "ask", question: label, required: true, fieldType: "text", why: "w" });
function summary(over: Partial<FormPlanSummary> = {}): FormPlanSummary {
  return { filled: 2, total: 2, filledLabels: [], filledAnswers: [filled("Email", "profile"), filled("Resume", "file")], unanswered: [], requiredUnanswered: [], hasCaptcha: false, readyToSubmit: true, ...over };
}
const verdict = (over: Partial<AutoSendVerdict> = {}): AutoSendVerdict => ({ lane: "auto", reason: "ok", summary: summary(), ...over });
const limits = (over: Partial<AutoSendLimits> = {}): AutoSendLimits => ({ envOn: true, runtimeOn: true, dailyCap: 10, now: NOW, ...over });
const history = (over: Partial<AutoSendHistory> = {}): AutoSendHistory => ({ sentToday: 0, recent: [], ...over });
const row = { company: "Acme B.V." };

describe("canAutoSend", () => {
  it("allows a clean auto row with both switches on", () => {
    expect(canAutoSend(row, verdict(), limits(), history())).toEqual({ ok: true });
  });
  it("refuses when the env switch is off", () => {
    expect(canAutoSend(row, verdict(), limits({ envOn: false }), history())).toMatchObject({ ok: false, reason: expect.stringContaining("AUTO_APPLY_SEND") });
  });
  it("refuses when the runtime switch is off", () => {
    expect(canAutoSend(row, verdict(), limits({ runtimeOn: false }), history())).toMatchObject({ ok: false, reason: expect.stringContaining("/autoapply") });
  });
  it.each(["needs_you", "hand_off"] as const)("refuses lane %s", (lane) => {
    expect(canAutoSend(row, verdict({ lane }), limits(), history())).toMatchObject({ ok: false });
  });
  it("refuses with no prepared form", () => {
    expect(canAutoSend(row, { lane: "auto", reason: "x" }, limits(), history())).toMatchObject({ ok: false });
  });
  it("refuses a bot check even on an auto lane", () => {
    expect(canAutoSend(row, verdict({ summary: summary({ hasCaptcha: true }) }), limits(), history())).toMatchObject({ ok: false, reason: expect.stringContaining("bot check") });
  });
  it("refuses any required question unanswered", () => {
    const v = verdict({ summary: summary({ requiredUnanswered: [ask("Favourite colour")] }) });
    expect(canAutoSend(row, v, limits(), history())).toMatchObject({ ok: false, reason: expect.stringContaining("unanswered") });
  });
  it("lets a required cover-letter question through (the send path writes and fact-checks it)", () => {
    const s = summary({ requiredUnanswered: [ask("Cover letter")] });
    expect(canAutoSend(row, verdict({ summary: s }), limits(), history())).toEqual({ ok: true });
    expect(letterIsRequired(s)).toBe(true);
    expect(letterIsRequired(summary())).toBe(false);
  });
  it("refuses an answer with an unknown source", () => {
    const s = summary({ filledAnswers: [filled("Email", "profile"), filled("Why us?", "unknown")] });
    expect(canAutoSend(row, verdict({ summary: s }), limits(), history())).toMatchObject({ ok: false, reason: expect.stringContaining("Why us?") });
  });
  it("refuses an answer with no recorded source", () => {
    const s = summary({ filledAnswers: [{ label: "Email", value: "v", fieldType: "text", editable: true }] });
    expect(canAutoSend(row, verdict({ summary: s }), limits(), history())).toMatchObject({ ok: false });
  });
  it("refuses a low-confidence answer even with a trusted source", () => {
    const s = summary({ filledAnswers: [filled("Notice period", "profile", 0.7)] });
    expect(canAutoSend(row, verdict({ summary: s }), limits(), history())).toMatchObject({ ok: false });
  });
  it("refuses a visa or self-ID answer whose source is not the profile, dossier or approved bank", () => {
    for (const label of ["Do you need visa sponsorship?", "Gender", "Are you legally eligible to work?"]) {
      const s = summary({ filledAnswers: [filled(label, "letter")] });
      expect(canAutoSend(row, verdict({ summary: s }), limits(), history())).toMatchObject({ ok: false });
    }
    const ok = summary({ filledAnswers: [filled("Do you need visa sponsorship?", "profile"), filled("Gender", "policy")] });
    expect(canAutoSend(row, verdict({ summary: ok }), limits(), history())).toEqual({ ok: true });
  });
  it("enforces the daily cap at the boundary", () => {
    expect(canAutoSend(row, verdict(), limits({ dailyCap: 3 }), history({ sentToday: 2 }))).toEqual({ ok: true });
    expect(canAutoSend(row, verdict(), limits({ dailyCap: 3 }), history({ sentToday: 3 }))).toMatchObject({ ok: false, reason: expect.stringContaining("daily cap") });
  });
  it("refuses the same company within 30 days, matching on the normalised name", () => {
    const recent = [{ company: "ACME BV", at: new Date(NOW.getTime() - 29 * DAY) }];
    expect(canAutoSend(row, verdict(), limits(), history({ recent }))).toMatchObject({ ok: false, reason: expect.stringContaining("30 days") });
  });
  it("allows the same company after 30 days and other companies inside it", () => {
    const old = [{ company: "Acme B.V.", at: new Date(NOW.getTime() - 31 * DAY) }];
    const other = [{ company: "Globex", at: new Date(NOW.getTime() - DAY) }];
    expect(canAutoSend(row, verdict(), limits(), history({ recent: old }))).toEqual({ ok: true });
    expect(canAutoSend(row, verdict(), limits(), history({ recent: other }))).toEqual({ ok: true });
  });
  it("refuses an empty company name", () => {
    expect(canAutoSend({ company: "  " }, verdict(), limits(), history())).toMatchObject({ ok: false });
  });
});

describe("env switches", () => {
  it("send switch is on only for exactly on", () => {
    expect(autoSendEnvOn({})).toBe(false);
    expect(autoSendEnvOn({ AUTO_APPLY_SEND: "off" })).toBe(false);
    expect(autoSendEnvOn({ AUTO_APPLY_SEND: "true" })).toBe(false);
    expect(autoSendEnvOn({ AUTO_APPLY_SEND: " ON " })).toBe(true);
  });
  it("cap defaults to 10 and rejects junk", () => {
    expect(dailyCapFrom({})).toBe(10);
    expect(dailyCapFrom({ AUTO_APPLY_DAILY_CAP: "4" })).toBe(4);
    expect(dailyCapFrom({ AUTO_APPLY_DAILY_CAP: "0" })).toBe(10);
    expect(dailyCapFrom({ AUTO_APPLY_DAILY_CAP: "x" })).toBe(10);
  });
});

describe("answerSourceOf", () => {
  it.each([
    ["explicitly answered in candidate question bank", "approved"],
    ['question_bank ("notice")', "approved"],
    ['dossier fact ("x")', "dossier"],
    ['dossier/profile rule (salary)', "dossier"],
    ["profile notice period", "profile"],
    ["matched email field", "profile"],
    ["matched current company field", "profile"],
    ["work_authorization=eu-citizen matched \"Yes\"", "profile"],
    ["answers.self_identification.gender in the candidate profile", "profile"],
    ["voluntary self-identification (gender) declined: no answers.self_identification.gender in the profile", "policy"],
    ["resume/CV upload field", "file"],
    ["matched cover-letter text field", "letter"],
    ["the model guessed", "unknown"],
    ["", "unknown"],
  ])("%s -> %s", (why, expected) => {
    expect(answerSourceOf(why)).toBe(expected);
  });
  it("isTrustedAnswer needs a source and confidence", () => {
    expect(isTrustedAnswer({ label: "Email" })).toBe(false);
    expect(isTrustedAnswer({ label: "Email", source: "profile", confidence: 1 })).toBe(true);
  });
});

describe("filled answers carry their source", () => {
  it("summariseFormPlan records the classed source and confidence of each filled action", async () => {
    const { summariseFormPlan } = await import("../../../src/tools/jobhunt/form-filled.js");
    const s = summariseFormPlan(
      [
        { selector: "#e", label: "Email", kind: "value", value: "x", confidence: 1, why: "matched email field" },
        { selector: "#g", label: "Guess", kind: "value", value: "x", confidence: 0.4, why: "model suggestion" },
      ],
      [],
    );
    expect(s.filledAnswers.map((a) => [a.source, a.confidence])).toEqual([["profile", 1], ["unknown", 0.4]]);
  });
});
