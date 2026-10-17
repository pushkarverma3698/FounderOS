import { describe, expect, it } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";
import { applyFieldName } from "../../../src/gateway/apply-page.js";
import { collectAnswers } from "../../../src/gateway/apply-answers.js";

const ROW = "11111111-2222-4333-8444-555555555555";
const MANY = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];

function form(pairs: Record<string, string>): URLSearchParams {
  return new URLSearchParams(Object.entries(pairs));
}

const BASE: ApplySnapshot = {
  rowId: ROW,
  chatId: "4242",
  profileId: "fixture-profile",
  company: "Acme BV",
  title: "Analyst",
  candidateName: "Fixture Person",
  targetUrl: "https://jobs.example.com/acme/1",
  platform: "lever",
  resumePath: "fixture-resume.pdf",
  summary: { filled: 1, total: 5, hasCaptcha: false, filledLabels: ["Full name"], unanswered: [] },
  createdAt: 0,
};

const QUESTIONS: ApplySnapshot["summary"]["unanswered"] = [
  { label: "Why Acme?", required: true, fieldType: "textarea" },
  { label: "Work permit", required: true, fieldType: "radio-group", options: ["Yes", "No"] },
  { label: "Region", required: false, fieldType: "select", options: MANY },
  { label: "Resume", required: true, fieldType: "file" },
];

function snap(): ApplySnapshot {
  return { ...BASE, summary: { ...BASE.summary, unanswered: QUESTIONS } };
}

const WHY = applyFieldName("Why Acme?");
const PERMIT = applyFieldName("Work permit");
const REGION = applyFieldName("Region");

describe("collectAnswers", () => {
  it("maps hashed field names back to labels and trims the answers", () => {
    const r = collectAnswers(snap(), form({ [WHY]: "  Because of the team.  ", [PERMIT]: "Yes" }));
    expect(r).toEqual({
      ok: true,
      answers: [
        { label: "Why Acme?", answer: "Because of the team." },
        { label: "Work permit", answer: "Yes" },
      ],
    });
  });

  it("ignores empty answers and accepts an empty form", () => {
    expect(collectAnswers(snap(), form({ [WHY]: "   ", [REGION]: "" }))).toEqual({ ok: true, answers: [] });
    expect(collectAnswers(snap(), form({}))).toEqual({ ok: true, answers: [] });
  });
});

describe("collectAnswers rejections", () => {
  it("rejects a field that is not in the snapshot", () => {
    const r = collectAnswers(snap(), form({ q_0000000000000000: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/form changed/i);
    expect(collectAnswers(snap(), form({ Resume: "x" })).ok).toBe(false);
  });

  it("rejects an answer for a file field, which the page does not offer", () => {
    expect(collectAnswers(snap(), form({ [applyFieldName("Resume")]: "cv.pdf" })).ok).toBe(false);
  });

  it("accepts an option answer only when it is an exact member of the options", () => {
    expect(collectAnswers(snap(), form({ [PERMIT]: "Maybe" })).ok).toBe(false);
    expect(collectAnswers(snap(), form({ [PERMIT]: "yes" })).ok).toBe(false);
    expect(collectAnswers(snap(), form({ [REGION]: "Gamma" })).ok).toBe(true);
    expect(collectAnswers(snap(), form({ [REGION]: "Zeta" })).ok).toBe(false);
  });
});

describe("collectAnswers text hygiene", () => {
  it("rejects an answer over 2000 characters instead of cutting it", () => {
    expect(collectAnswers(snap(), form({ [WHY]: "a".repeat(2001) })).ok).toBe(false);
    expect(collectAnswers(snap(), form({ [WHY]: "a".repeat(2000) })).ok).toBe(true);
  });

  it("normalises line endings and drops control characters", () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const raw = `line one${cr}${lf}line two${nul}${bell}!`;
    const r = collectAnswers(snap(), form({ [WHY]: raw }));
    expect(r).toEqual({ ok: true, answers: [{ label: "Why Acme?", answer: `line one${lf}line two!` }] });
  });
});
