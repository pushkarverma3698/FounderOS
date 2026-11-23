/**
 * Claude hand-off lane, pure rules (#1330). Proves:
 *  1. lane selection: wizard / custom-site / no-fillable-fields rows join; bot checks (the TS worker's), aggregators,
 *     LinkedIn, expired and non-hand-off rows do not; Workday joins only with the flag.
 *  2. state transitions: submitted only after filled_to_submit; the TS worker's `confirmed` is refused on this lane;
 *     a filled row is never "applied" by reading it.
 *  3. the filled report round-trips (clipped) and the filled list is oldest first and skips applied rows.
 *  4. message splitting: one message when short, tabs never cut, every message under the limit, numbering continuous.
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_FILLED_PREFIX, CLAUDE_LANE, claudeFilledRows, claudeLaneOf, claudeReasonSql, claudeStateOf, formatFilledMessages, formatFilledResult,
  MAX_BLANKS, parseFilledResult, transitionAllowed, type ClaudeFilledRow,
} from "../../../src/tools/jobhunt/claude-lane-rules.js";
import { isMacEligibleReason } from "../../../src/tools/jobhunt/mac-worker-rules.js";

const hand = (reason: string, lane = "hand_off") => ({ apply_lane: lane, apply_lane_reason: reason });
const off = { workday: false };
const on = { workday: true };

describe("lane selection", () => {
  it.each([
    "Form not usable: no fillable form fields were found on this page (the form may be behind a login or custom widget)",
    "Form not usable: multi-step wizard, next page never reached",
    "Form not usable: form run crashed: timeout",
  ])("takes %s", (reason) => {
    expect(claudeLaneOf(hand(reason), off)).toBe(CLAUDE_LANE);
  });

  it.each([
    ["a CAPTCHA the TS worker takes", "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it"],
    ["a bot check the TS worker takes", "Bot check blocks automation: DataDome"],
    ["an aggregator page", "Form not usable: Jobicy is an aggregator page without an embedded application form"],
    ["LinkedIn", "Form not usable: LinkedIn requires an authenticated browser session"],
    ["no link", "Form not usable: no valid http(s) URL on file for this role"],
    ["an expired posting", "Expired: position has been filled"],
    ["an ATS fit miss", "ATS fit 40% below 60%; missing: kubernetes"],
  ])("leaves out %s", (_n, reason) => {
    expect(claudeLaneOf(hand(reason), on)).toBeNull();
  });

  it("only hand_off rows join, whatever the reason", () => {
    expect(claudeLaneOf(hand("Form not usable: wizard", "needs_you"), off)).toBeNull();
    expect(claudeLaneOf({ apply_lane: null, apply_lane_reason: null }, off)).toBeNull();
  });

  it("Workday joins only when the flag is on", () => {
    const reason = "Workday: Workday requires per-company account creation and multi-step login";
    expect(claudeLaneOf(hand(reason), off)).toBeNull();
    expect(claudeLaneOf(hand(reason), on)).toBe(CLAUDE_LANE);
    expect(claudeReasonSql(false)).not.toContain("Workday");
    expect(claudeReasonSql(true)).toContain("Workday");
  });

  it("never overlaps the TS worker: no reason is in both lanes", () => {
    for (const reason of ["Form not usable: captcha on step 2", "Workday: turnstile", "Form not usable: wizard", "Bot check blocks automation: x"]) {
      expect(isMacEligibleReason(reason) && claudeLaneOf(hand(reason), on) !== null).toBe(false);
    }
  });
});

describe("state transitions", () => {
  it("submitted needs filled_to_submit first", () => {
    expect(transitionAllowed("leased", "submitted").ok).toBe(false);
    expect(transitionAllowed("filled_to_submit", "submitted").ok).toBe(true);
  });

  it("filled_to_submit can be reported from a fresh lease and re-reported; failed ends either state", () => {
    expect(transitionAllowed("leased", "filled_to_submit").ok).toBe(true);
    expect(transitionAllowed("filled_to_submit", "filled_to_submit").ok).toBe(true);
    expect(transitionAllowed("leased", "failed").ok).toBe(true);
    expect(transitionAllowed("filled_to_submit", "failed").ok).toBe(true);
  });

  it("the TS worker's confirmed is refused on this lane, in both states", () => {
    expect(transitionAllowed("leased", "confirmed").ok).toBe(false);
    expect(transitionAllowed("filled_to_submit", "confirmed").ok).toBe(false);
  });

  it("state is read from mac_result; an applied row is not filled", () => {
    expect(claudeStateOf({ mac_result: formatFilledResult({ link: "https://x.test/s", blanks: [] }) })).toBe("filled_to_submit");
    expect(claudeStateOf({ mac_result: "failed: dry run" })).toBe("leased");
    expect(claudeStateOf({ mac_result: null })).toBe("leased");
    expect(claudeStateOf({ mac_result: `${CLAUDE_FILLED_PREFIX}{}`, applied_at: new Date() })).toBe("leased");
  });
});

describe("filled report", () => {
  it("round-trips link and blanks, clipping long entries and the list", () => {
    const blanks = Array.from({ length: MAX_BLANKS + 5 }, (_, i) => `Question ${i} ${"x".repeat(200)}`);
    const parsed = parseFilledResult(formatFilledResult({ link: " https://x.test/submit ", blanks }));
    expect(parsed?.link).toBe("https://x.test/submit");
    expect(parsed?.blanks).toHaveLength(MAX_BLANKS);
    expect(parsed?.blanks[0]?.length).toBeLessThanOrEqual(80);
  });

  it("is null for other results and keeps a damaged one visible", () => {
    expect(parseFilledResult("failed: x")).toBeNull();
    expect(parseFilledResult(null)).toBeNull();
    expect(parseFilledResult(`${CLAUDE_FILLED_PREFIX}{not json`)).toEqual({ link: "", blanks: [] });
  });

  it("lists filled rows oldest first and skips applied and non-filled ones", () => {
    const src = (id: string, mac: string | null, at: string, applied: Date | null = null) =>
      ({ id, company: id, title: "T", mac_result: mac, mac_result_at: new Date(at), applied_at: applied });
    const f = formatFilledResult({ link: "https://x.test/s", blanks: ["Visa"] });
    const out = claudeFilledRows([
      src("late", f, "2026-11-23T10:00:00Z"), src("early", f, "2026-11-23T08:00:00Z"),
      src("done", f, "2026-11-23T09:00:00Z", new Date()), src("failed", "failed: x", "2026-11-23T09:00:00Z"),
    ]);
    expect(out.map((r) => r.rowId)).toEqual(["early", "late"]);
    expect(out[0]?.blanks).toEqual(["Visa"]);
  });
});

describe("message splitting", () => {
  const rowOf = (i: number, blanks: string[] = []): ClaudeFilledRow => ({
    rowId: `id-${i}`, company: `Company ${i} & <Co>`, title: "Engineer", link: `https://jobs.example.test/${i}/submit`, blanks, filledAt: null,
  });

  it("is empty for no rows and one message for a few", () => {
    expect(formatFilledMessages([])).toEqual([]);
    const one = formatFilledMessages([rowOf(1, ["Visa status"]), rowOf(2)]);
    expect(one).toHaveLength(1);
    expect(one[0]).toContain("filled 2 forms");
    expect(one[0]).toContain("1. <b>Company 1 &amp; &lt;Co&gt;</b>");
    expect(one[0]).toContain("Left blank: Visa status");
    expect(one[0]).toContain("Nothing left blank");
    expect(one[0]).toContain("https://jobs.example.test/2/submit");
  });

  it("splits long runs at tab boundaries: every message under the limit, every tab once, numbering continuous", () => {
    const rows = Array.from({ length: 10 }, (_, i) => rowOf(i + 1, Array.from({ length: 8 }, (_, j) => `Blank field number ${j} for row ${i}`)));
    const msgs = formatFilledMessages(rows, 900);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(900);
    const all = msgs.join("\n");
    for (let n = 1; n <= 10; n++) expect(all.match(new RegExp(`^${n}\\. <b>`, "gm"))).toHaveLength(1);
    expect(msgs[0]).toContain(`(1/${msgs.length})`);
    expect(msgs.at(-1)).toContain(`(${msgs.length}/${msgs.length})`);
  });

  it("shortens one tab that alone exceeds the limit instead of dropping it", () => {
    const msgs = formatFilledMessages([rowOf(1, Array.from({ length: 40 }, (_, i) => `Long blank label ${i} ${"y".repeat(60)}`))], 600);
    expect(msgs.join("\n")).toContain("1. <b>");
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(600);
  });
});
