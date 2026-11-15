import { describe, expect, it } from "vitest";
import { isShadowCandidate, routeLane, type LaneCandidateRow } from "../../../src/tools/jobhunt/apply-lane.js";
import type { FormPlanSummary, UnansweredQuestion } from "../../../src/tools/jobhunt/form-filled.js";
import { formatShadowSummary, type ShadowRoutedRow } from "../../../src/tools/jobhunt/shadow-apply-report.js";

const NOW = new Date("2026-11-15T12:00:00Z");
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);
const PASS = JSON.stringify([
  { gate: "Sponsor", status: "pass", evidence: "x" },
  { gate: "Salary", status: "pass", evidence: "y" },
]);
const row = (over: Partial<LaneCandidateRow> = {}): LaneCandidateRow => ({
  gate_json: PASS, created_at: hoursAgo(1), applied_at: null, skipped_at: null, liveness: "unknown", apply_lane_at: null, ...over,
});

describe("isShadowCandidate", () => {
  it("accepts a fresh all-pass row with no lane, whatever its liveness besides expired", () => {
    expect(isShadowCandidate(row(), NOW)).toBe(true);
    expect(isShadowCandidate(row({ liveness: "live" }), NOW)).toBe(true);
  });
  it("rejects a flag or reject gate, no gate_json, and an empty gate list", () => {
    const flag = JSON.stringify([{ gate: "Salary", status: "flag", evidence: "?" }, { gate: "Sponsor", status: "pass", evidence: "" }]);
    expect(isShadowCandidate(row({ gate_json: flag }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ gate_json: null }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ gate_json: "[]" }), NOW)).toBe(false);
  });
  it("rejects rows older than 24h, applied, skipped or expired", () => {
    expect(isShadowCandidate(row({ created_at: hoursAgo(25) }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ created_at: null }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ applied_at: hoursAgo(1) }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ skipped_at: hoursAgo(1) }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ liveness: "expired" }), NOW)).toBe(false);
  });
  it("routes a row at most once per 24h", () => {
    expect(isShadowCandidate(row({ apply_lane_at: hoursAgo(2) }), NOW)).toBe(false);
    expect(isShadowCandidate(row({ apply_lane_at: hoursAgo(25) }), NOW)).toBe(true);
  });
});

const ask = (label: string): UnansweredQuestion => ({
  selector: `#${label}`, label, kind: "ask", question: label, required: true, fieldType: "text", why: "no answer on file",
});
const summary = (over: Partial<FormPlanSummary> = {}): FormPlanSummary => ({
  filled: 8, total: 8, filledLabels: [], filledAnswers: [], unanswered: [], requiredUnanswered: [], hasCaptcha: false, readyToSubmit: true, ...over,
});
const prepared = (s: FormPlanSummary, platform: "lever" | "greenhouse" = "lever") => ({ kind: "prepared" as const, platform, summary: s });

describe("routeLane", () => {
  it("auto: no bot check, nothing required open, letter skipped in shadow noted", () => {
    const v = routeLane(prepared(summary()));
    expect(v.lane).toBe("auto");
    expect(v.reason).toContain("no cover letter field");
    expect(v.reason).toContain("letter skipped in shadow");
  });
  it("auto: an unanswered cover-letter field does not block, and the reason says the field exists", () => {
    const v = routeLane(prepared(summary({ requiredUnanswered: [ask("Cover letter")] })));
    expect(v.lane).toBe("auto");
    expect(v.reason).toContain("cover letter field present");
  });
  it("needs_you: lists the unanswered required questions", () => {
    const v = routeLane(prepared(summary({ requiredUnanswered: [ask("Why us?"), ask("Cover letter"), ask("Notice period")] })));
    expect(v.lane).toBe("needs_you");
    expect(v.reason).toContain("2 required question(s) unanswered: Why us?; Notice period");
  });
  it("needs_you: Greenhouse emailed code", () => {
    const v = routeLane(prepared(summary(), "greenhouse"));
    expect(v.lane).toBe("needs_you");
    expect(v.reason).toMatch(/Greenhouse emails a confirmation code/);
  });
  it("hand_off: CAPTCHA on a prepared form beats everything else", () => {
    const v = routeLane(prepared(summary({ hasCaptcha: true, requiredUnanswered: [ask("Why us?")] }), "greenhouse"));
    expect(v.lane).toBe("hand_off");
    expect(v.reason).toMatch(/CAPTCHA/);
  });
  it.each([
    ["SmartRecruiters: the apply page sits behind a DataDome bot check", /^Bot check/],
    ["Workday requires per-company account creation and multi-step login", /^Workday/],
    ["SmartRecruiters: this job has expired and no longer takes applications", /^Expired/],
    ["Himalayas is an aggregator page without an embedded application form", /^Form not usable/],
    ["SmartRecruiters: the apply page showed no form fields", /^Form not usable/],
  ])("hand_off: %s", (reason, expected) => {
    const v = routeLane({ kind: "failed", reason, platform: null });
    expect(v.lane).toBe("hand_off");
    expect(v.reason).toMatch(expected);
    expect(v.reason).toContain(reason);
  });
});

describe("formatShadowSummary", () => {
  const r = (lane: ShadowRoutedRow["lane"], company = "A & B"): ShadowRoutedRow => ({ company, title: "Dev <x>", profileId: "pushkar-nl-tech", lane, reason: "why" });
  it("sends nothing for nothing", () => expect(formatShadowSummary([])).toEqual([]));
  it("counts lanes, escapes HTML, one line per role", () => {
    const [msg, ...rest] = formatShadowSummary([r("auto"), r("needs_you"), r("hand_off"), r("hand_off")]);
    expect(rest).toEqual([]);
    expect(msg).toContain("Shadow apply: 4 prepared — auto 1, needs you 1, hand-off 2");
    expect(msg).toContain("A &amp; B");
    expect(msg).toContain("Dev &lt;x&gt;");
    expect(msg?.split("\n")).toHaveLength(5);
  });
  it("splits a long list instead of dropping rows", () => {
    const rows = Array.from({ length: 80 }, (_, i) => r("hand_off", `Company ${i}`));
    const msgs = formatShadowSummary(rows);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.length <= 3600)).toBe(true);
    expect(msgs.join("\n").match(/•/g)).toHaveLength(80);
  });
});
