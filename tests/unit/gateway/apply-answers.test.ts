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
  summary: { filled: 1, total: 5, hasCaptcha: false, filledLabels: ["Full name"], filledAnswers: [], unanswered: [] },
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

  it("joins a multi-line answer into one line and drops control characters", () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const raw = `line one${cr}${lf}line two${nul}${bell}!`;
    const r = collectAnswers(snap(), form({ [WHY]: raw }));
    expect(r).toEqual({ ok: true, answers: [{ label: "Why Acme?", answer: "line one line two!" }] });
  });

  it("keeps a colon on a later line from becoming its own dossier entry", () => {
    const lf = String.fromCharCode(10);
    const r = collectAnswers(snap(), form({ [WHY]: `Because I like it.${lf}${lf}Phone: 0000${lf}` }));
    expect(r).toEqual({ ok: true, answers: [{ label: "Why Acme?", answer: "Because I like it. Phone: 0000" }] });
  });
});

type FilledEntry = ApplySnapshot["summary"]["filledAnswers"][number];

const FILLED: FilledEntry[] = [
  { label: "Full name", value: "Fixture Person", fieldType: "text", editable: true },
  { label: "Location (City)*", value: "Amsterdam, Netherlands", fieldType: "text", editable: true },
  { label: "Relocate", value: "No", fieldType: "radio-group", options: ["Yes", "No"], editable: true },
  { label: "Source", value: "Beta", fieldType: "select", options: MANY, editable: true },
  { label: "Resume/CV", value: "cv.pdf", fieldType: "file", editable: false },
  { label: "I agree", value: "Yes", fieldType: "checkbox", editable: false },
];

function snapFilled(filledAnswers: FilledEntry[] = FILLED): ApplySnapshot {
  return { ...BASE, summary: { ...BASE.summary, filledAnswers, unanswered: QUESTIONS } };
}

const NAME = applyFieldName("Full name");
const CITY = applyFieldName("Location (City)*");
const RELOCATE = applyFieldName("Relocate");
const SOURCE = applyFieldName("Source");

describe("collectAnswers filled values", () => {
  it("collects a filled field the founder changed", () => {
    const r = collectAnswers(snapFilled(), form({ [CITY]: "Utrecht" }));
    expect(r).toEqual({ ok: true, answers: [{ label: "Location (City)*", answer: "Utrecht" }] });
  });

  it("does not collect a filled field posted back unchanged", () => {
    const r = collectAnswers(snapFilled(), form({ [NAME]: "Fixture Person", [CITY]: "Amsterdam, Netherlands", [RELOCATE]: "No" }));
    expect(r).toEqual({ ok: true, answers: [] });
  });

  it("compares after the same cleanup the answer gets, so a browser round trip is still unchanged", () => {
    const crlf = String.fromCharCode(13) + String.fromCharCode(10);
    const r = collectAnswers(snapFilled(), form({ [CITY]: `  Amsterdam,${crlf}Netherlands ` }));
    expect(r).toEqual({ ok: true, answers: [] });
  });

  it("does not collect an emptied filled field", () => {
    expect(collectAnswers(snapFilled(), form({ [NAME]: "   " }))).toEqual({ ok: true, answers: [] });
  });

  it("collects changes to filled fields and open questions together", () => {
    const r = collectAnswers(snapFilled(), form({ [WHY]: "Because.", [NAME]: "Fixture P.", [CITY]: "Amsterdam, Netherlands", [RELOCATE]: "Yes" }));
    expect(r).toEqual({
      ok: true,
      answers: [
        { label: "Why Acme?", answer: "Because." },
        { label: "Full name", answer: "Fixture P." },
        { label: "Relocate", answer: "Yes" },
      ],
    });
  });

  it("holds a changed filled choice to its options", () => {
    expect(collectAnswers(snapFilled(), form({ [RELOCATE]: "Maybe" })).ok).toBe(false);
    expect(collectAnswers(snapFilled(), form({ [SOURCE]: "Zeta" })).ok).toBe(false);
    expect(collectAnswers(snapFilled(), form({ [SOURCE]: "Gamma" })).ok).toBe(true);
  });

  it("does not reject a filled value that is unchanged but outside the options or over the cap", () => {
    const odd: FilledEntry[] = [
      { label: "Odd", value: "Other", fieldType: "select", options: ["A", "B"], editable: true },
      { label: "Long", value: "y".repeat(2001), fieldType: "text", editable: true },
    ];
    const posted = form({ [applyFieldName("Odd")]: "Other", [applyFieldName("Long")]: "y".repeat(2001) });
    expect(collectAnswers(snapFilled(odd), posted)).toEqual({ ok: true, answers: [] });
    expect(collectAnswers(snapFilled(odd), form({ [applyFieldName("Odd")]: "C" })).ok).toBe(false);
    expect(collectAnswers(snapFilled(odd), form({ [applyFieldName("Long")]: "z".repeat(2001) })).ok).toBe(false);
  });

  it("refuses a file field and a non-editable field, which the page does not offer", () => {
    expect(collectAnswers(snapFilled(), form({ [applyFieldName("Resume/CV")]: "other.pdf" })).ok).toBe(false);
    expect(collectAnswers(snapFilled(), form({ [applyFieldName("I agree")]: "No" })).ok).toBe(false);
  });

  it("lets an open question keep a name that a filled field would also use", () => {
    const clash: FilledEntry[] = [{ label: "Region", value: "Alpha", fieldType: "select", options: MANY, editable: true }];
    expect(collectAnswers(snapFilled(clash), form({ [REGION]: "Alpha" }))).toEqual({
      ok: true,
      answers: [{ label: "Region", answer: "Alpha" }],
    });
  });

  it("still rejects a name that is neither an open question nor a filled field", () => {
    const r = collectAnswers(snapFilled(), form({ q_0000000000000000: "x" }));
    expect(r.ok).toBe(false);
  });
});
