/**
 * Coding-pipeline cards: the spec card and the evidence card the founder decides on.
 * Pure renderers, no Telegram client. Every assertion is about what the founder sees or
 * can tap, because a hidden reason or a wrong button is the failure this file exists to stop.
 */
import { describe, it, expect } from "vitest";
import type { InlineKeyboard } from "grammy";
import {
  renderSpecCard,
  renderEvidenceCard,
  parseCodingCallback,
  TELEGRAM_HTML_LIMIT,
  type EvidenceCardInput,
} from "../../../src/gateway/coding-cards.js";
import type { TaskContract } from "../../../src/tools/task-contract.js";
import type { SpecGateResult } from "../../../src/tools/spec-gate.js";

const SHA = "a".repeat(40);
/** Angle brackets are built, not typed, so the raw markup an attacker would send is explicit. */
const LT = String.fromCharCode(60);
const QUOT = String.fromCharCode(34);

function contract(over: Partial<TaskContract> = {}): TaskContract {
  const base = {
    version: 1,
    ask: "hide closed issues in the tasks list",
    repo: "acme/widgets",
    task_type: "bugfix",
    base_sha: SHA,
    current_behavior: {
      text: "The list shows closed issues",
      citations: [{ line: 42, path: "src/gateway/tasks-ready.ts", sha: SHA }],
    },
    expected_behavior: "Closed issues are hidden",
    scope: ["src/gateway/**"],
    locked_tests: ["tests/unit/gateway/tasks-ready.test.ts"],
    oracle: { kind: "unit-only", id: "o1", before: {}, expected_after: {} },
    risk: "low",
    limits: { files: 3, lines: 100, deleted_lines: 20, new_dependencies: false },
  };
  return Object.assign({}, base, over) as TaskContract;
}

const PASS_GATE: SpecGateResult = {
  status: "PASS",
  questions: [],
  effectiveRisk: "low",
  fingerprint: "f".repeat(64),
};
const gate = (over: Partial<SpecGateResult>): SpecGateResult => Object.assign({}, PASS_GATE, over);
const OPTS = { nonce: "abc123", repo: "acme/widgets", issue: 12 };
const opts = (over: Partial<typeof OPTS>) => Object.assign({}, OPTS, over);

type Verdict = { status: "PASS" | "FAIL" | "UNKNOWN"; reasons: string[] };
const P: Verdict = { status: "PASS", reasons: [] };

function evidence(over: Partial<EvidenceCardInput> = {}): EvidenceCardInput {
  const base: EvidenceCardInput = {
    spec: P,
    green: P,
    review: { decision: "APPROVE", findings: [] },
    merge: { ok: true, reasons: [] },
    notVerified: [],
    prUrl: "https://github.com/acme/widgets/pull/9",
    nonce: "abc123",
  };
  return Object.assign({}, base, over);
}

type Btn = { text: string; callback_data?: string; url?: string };
function buttons(kb: InlineKeyboard): Btn[] {
  return kb.inline_keyboard.flat() as Btn[];
}
const text = (kb: InlineKeyboard) => buttons(kb).map((b) => b.text);
const joined = (html: string[]) => html.join("\n");
const hasMerge = (kb: InlineKeyboard) => buttons(kb).some((b) => b.callback_data?.startsWith("cp:merge"));
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("renderSpecCard", () => {
  it("shows Now/After/Test/Scope/Risk lines with the citation rendered", () => {
    const { html, keyboard } = renderSpecCard(contract(), PASS_GATE, OPTS);
    const h = joined(html);
    expect(h).toContain("Now: The list shows closed issues");
    expect(h).toContain("src/gateway/tasks-ready.ts:42@aaaaaaa");
    expect(h).toContain("After: Closed issues are hidden");
    expect(h).toContain("Test: ");
    expect(h).toContain("tests/unit/gateway/tasks-ready.test.ts");
    expect(h).toContain("Scope: ");
    expect(h).toContain("src/gateway/**");
    expect(h).toContain("Risk: low");
    expect(h).not.toContain("raised from");
    expect(text(keyboard)).toEqual(["✅ Approve", "✏️ Change", "❌ Cancel"]);
  });

  it("ASK prints the questions and drops Approve", () => {
    const ask = gate({ status: "ASK", questions: ["Which directory?", "Which test?"] });
    const { html, keyboard } = renderSpecCard(contract(), ask, OPTS);
    const h = joined(html);
    expect(h).toContain("Which directory?");
    expect(h).toContain("Which test?");
    expect(text(keyboard)).toEqual(["✏️ Change", "❌ Cancel"]);
    expect(buttons(keyboard).some((b) => b.callback_data?.startsWith("cp:approve:"))).toBe(false);
  });

  it("shows (raised from X) when the gate raised the risk", () => {
    const { html } = renderSpecCard(contract({ risk: "low" }), gate({ effectiveRisk: "high" }), OPTS);
    expect(joined(html)).toContain("Risk: high (raised from low)");
  });

  it("escapes HTML in the behaviour text, paths, scope, questions and repo", () => {
    const evil = LT + "script>alert(1)" + LT + "script>";
    const c = contract({
      current_behavior: { text: evil, citations: [{ line: 1, path: "src/" + LT + "b>x.ts", sha: SHA }] },
      expected_behavior: "a & b " + LT + "i>",
      scope: ["src/" + LT + "u>/**"],
      locked_tests: ["tests/" + LT + "img src=x>.test.ts"],
    });
    const ask = gate({ status: "ASK", questions: ["is " + LT + "b>this ok?"] });
    const h = joined(renderSpecCard(c, ask, opts({ repo: "a/" + LT + "x>" })).html);
    for (const tag of ["script>", "b>", "i>", "u>", "img ", "x>"]) expect(h).not.toContain(LT + tag);
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("a &amp; b");
  });

  it("splits very long untrusted text across parts without dropping any of it", () => {
    const long = "w".repeat(9000);
    const { html } = renderSpecCard(contract({ expected_behavior: long }), PASS_GATE, OPTS);
    expect(html.length).toBeGreaterThan(1);
    for (const part of html) expect(part.length).toBeLessThan(TELEGRAM_HTML_LIMIT);
    expect(count(joined(html), "w")).toBeGreaterThanOrEqual(9000);
  });

  it("rejects a nonce that would break callback data", () => {
    expect(() => renderSpecCard(contract(), PASS_GATE, opts({ nonce: "a:b" }))).toThrow();
    expect(() => renderSpecCard(contract(), PASS_GATE, opts({ nonce: "x".repeat(60) }))).toThrow();
    expect(() => renderSpecCard(contract(), PASS_GATE, opts({ nonce: "" }))).toThrow();
  });
});

describe("renderEvidenceCard", () => {
  it("all green offers [Merge] and an Open PR url button", () => {
    const { html, keyboard } = renderEvidenceCard(evidence());
    const h = joined(html);
    expect(h).toContain("Red before: ✓ PASS");
    expect(h).toContain("Green after: ✓ PASS");
    expect(h).toContain("Gate: ✓ PASS");
    expect(h).toContain("Review: ✓ PASS");
    const b = buttons(keyboard);
    expect(b.find((x) => x.callback_data === "cp:merge:abc123")?.text).toContain("Merge");
    expect(b.find((x) => x.url)?.url).toBe("https://github.com/acme/widgets/pull/9");
    expect(b.some((x) => x.callback_data?.startsWith("cp:merge_ack:"))).toBe(false);
  });

  it("null review is ? UNKNOWN, never a tick, and offers no merge", () => {
    const { html, keyboard } = renderEvidenceCard(evidence({ review: null }));
    const h = joined(html);
    expect(h).toContain("Review: ? UNKNOWN");
    expect(h).not.toContain("Review: ✓");
    expect(hasMerge(keyboard)).toBe(false);
  });

  const nonPass: Array<[string, Partial<EvidenceCardInput>]> = [
    ["spec FAIL", { spec: { status: "FAIL", reasons: ["tests passed before the fix"] } }],
    ["spec UNKNOWN", { spec: { status: "UNKNOWN", reasons: ["no check run found"] } }],
    ["green FAIL", { green: { status: "FAIL", reasons: ["ci red"] } }],
    ["green UNKNOWN", { green: { status: "UNKNOWN", reasons: ["ci pending"] } }],
    ["review null", { review: null }],
    ["review UNKNOWN", { review: { decision: "UNKNOWN", findings: [] } }],
    ["review REQUEST_CHANGES", { review: { decision: "REQUEST_CHANGES", findings: [{ severity: "blocker", claim: "bad" }] } }],
    ["merge not ok", { merge: { ok: false, reasons: ["head moved"] } }],
    ["merge ok undefined", { merge: { ok: undefined as unknown as boolean, reasons: [] } }],
    ["merge ok truthy string", { merge: { ok: "true" as unknown as boolean, reasons: [] } }],
    ["bogus lowercase status", { green: { status: "pass" as "PASS", reasons: [] } }],
  ];
  it.each(nonPass)("%s: no merge button of either kind", (_n, over) => {
    const { keyboard } = renderEvidenceCard(evidence(over));
    expect(hasMerge(keyboard)).toBe(false);
    expect(buttons(keyboard).some((b) => b.url)).toBe(true);
  });

  it("non-PASS rows list every reason, with the right mark", () => {
    const h = joined(
      renderEvidenceCard(
        evidence({
          spec: { status: "FAIL", reasons: ["r-one", "r-two"] },
          green: { status: "UNKNOWN", reasons: ["r-three"] },
          merge: { ok: false, reasons: ["r-four"] },
        }),
      ).html,
    );
    expect(h).toContain("Red before: ✗ FAIL");
    expect(h).toContain("Green after: ? UNKNOWN");
    expect(h).toContain("Gate: ✗ FAIL");
    for (const r of ["r-one", "r-two", "r-three", "r-four"]) expect(h).toContain(r);
  });

  it("a non-PASS verdict with no reasons still says so", () => {
    const h = joined(renderEvidenceCard(evidence({ green: { status: "FAIL", reasons: [] } })).html);
    expect(h).toContain("no reason given");
  });

  it("review findings are listed with severity and location", () => {
    const findings = [
      { severity: "blocker", claim: "drops rows", file: "src/a.ts", line: 7 },
      { severity: "minor", claim: "naming" },
    ];
    const h = joined(renderEvidenceCard(evidence({ review: { decision: "REQUEST_CHANGES", findings } })).html);
    expect(h).toContain("Review: ✗ FAIL");
    expect(h).toContain("blocker");
    expect(h).toContain("drops rows");
    expect(h).toContain("src/a.ts:7");
    expect(h).toContain("naming");
  });

  it("an APPROVE review still shows its findings", () => {
    const findings = [{ severity: "major", claim: "edge case missed" }];
    const h = joined(renderEvidenceCard(evidence({ review: { decision: "APPROVE", findings } })).html);
    expect(h).toContain("Review: ✓ PASS");
    expect(h).toContain("edge case missed");
  });

  it("notVerified swaps [Merge] for [I checked it — merge] and lists the items above the buttons", () => {
    const { html, keyboard } = renderEvidenceCard(evidence({ notVerified: ["live Telegram run", "prod oracle"] }));
    const h = joined(html);
    expect(h).toContain("NOT VERIFIED");
    expect(h).toContain("live Telegram run");
    expect(h).toContain("prod oracle");
    const b = buttons(keyboard);
    expect(b.find((x) => x.callback_data === "cp:merge_ack:abc123")?.text).toContain("I checked it");
    expect(b.some((x) => x.callback_data === "cp:merge:abc123")).toBe(false);
  });

  it("notVerified is listed even when there is no merge button", () => {
    const { html } = renderEvidenceCard(evidence({ notVerified: ["thing x"], merge: { ok: false, reasons: ["r"] } }));
    expect(joined(html)).toContain("thing x");
  });

  it("merge.ok true while a row is not PASS is called out, not trusted", () => {
    const { html, keyboard } = renderEvidenceCard(evidence({ green: { status: "FAIL", reasons: ["ci red"] } }));
    expect(joined(html)).toMatch(new RegExp("inconsistent", "i"));
    expect(hasMerge(keyboard)).toBe(false);
  });

  it("escapes HTML in reasons, findings, not-verified items", () => {
    const findings = [{ severity: "major", claim: LT + "i>x", file: LT + "u>.ts" }];
    const h = joined(
      renderEvidenceCard(
        evidence({
          spec: { status: "FAIL", reasons: [LT + "b>bold" + LT + "b> & more"] },
          review: { decision: "REQUEST_CHANGES", findings },
          notVerified: [LT + "a href=x"],
        }),
      ).html,
    );
    for (const tag of ["b>bold", "i>x", "u>.ts", "a href"]) expect(h).not.toContain(LT + tag);
    expect(h).toContain("&lt;b&gt;bold&lt;b&gt; &amp; more");
  });

  it("60 long reasons all appear across parts, each part under the Telegram limit", () => {
    const reasons = Array.from({ length: 60 }, (_, i) => "reason-" + i + "-" + "x".repeat(200));
    const { html } = renderEvidenceCard(evidence({ green: { status: "FAIL", reasons } }));
    expect(html.length).toBeGreaterThan(1);
    for (const part of html) expect(part.length).toBeLessThan(TELEGRAM_HTML_LIMIT);
    const h = joined(html);
    for (let i = 0; i < 60; i++) expect(h).toContain("reason-" + i + "-");
  });

  it("one 10k-char reason is split, not truncated", () => {
    const reason = "q".repeat(10000);
    const { html } = renderEvidenceCard(evidence({ spec: { status: "FAIL", reasons: [reason] } }));
    for (const part of html) expect(part.length).toBeLessThan(TELEGRAM_HTML_LIMIT);
    expect(count(joined(html), "q")).toBeGreaterThanOrEqual(10000);
  });

  it("a split never cuts an HTML entity or leaves a tag open", () => {
    const reason = (LT + "" + String.fromCharCode(62) + "&" + QUOT).repeat(2000);
    const { html } = renderEvidenceCard(evidence({ spec: { status: "FAIL", reasons: [reason] } }));
    expect(html.length).toBeGreaterThan(1);
    const dangling = new RegExp("&[a-z]*$");
    const slash = String.fromCharCode(47);
    for (const part of html) {
      expect(dangling.test(part)).toBe(false);
      expect(count(part, LT + "code>")).toBe(count(part, LT + slash + "code>"));
      expect(count(part, LT + "b>")).toBe(count(part, LT + slash + "b>"));
    }
  });

  it("all non-PASS reasons survive when every row fails at once", () => {
    const mk = (tag: string) => Array.from({ length: 25 }, (_, i) => tag + i + "-" + "z".repeat(150));
    const { html } = renderEvidenceCard(
      evidence({
        spec: { status: "FAIL", reasons: mk("S") },
        green: { status: "UNKNOWN", reasons: mk("G") },
        merge: { ok: false, reasons: mk("M") },
        review: { decision: "UNKNOWN", findings: [] },
      }),
    );
    const h = joined(html);
    for (const tag of ["S", "G", "M"]) for (let i = 0; i < 25; i++) expect(h).toContain(tag + i + "-");
  });

  it("rejects a non-https PR url and a bad nonce", () => {
    expect(() => renderEvidenceCard(evidence({ prUrl: "javascript:alert(1)" }))).toThrow();
    expect(() => renderEvidenceCard(evidence({ prUrl: "not a url" }))).toThrow();
    expect(() => renderEvidenceCard(evidence({ nonce: "a:b" }))).toThrow();
  });
});

describe("callback data", () => {
  const nonce = "n".repeat(32);
  it("every callback_data is at most 64 bytes, even at the longest legal nonce", () => {
    const ask = gate({ status: "ASK", questions: ["q"] });
    const cards = [
      renderSpecCard(contract(), PASS_GATE, opts({ nonce })).keyboard,
      renderSpecCard(contract(), ask, opts({ nonce })).keyboard,
      renderEvidenceCard(evidence({ nonce })).keyboard,
      renderEvidenceCard(evidence({ nonce, notVerified: ["x"] })).keyboard,
    ];
    let checked = 0;
    for (const kb of cards) {
      for (const b of buttons(kb)) {
        if (b.callback_data === undefined) continue;
        checked++;
        expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
    expect(checked).toBe(7);
  });

  it("every rendered callback parses back to its action and nonce", () => {
    const kbs = [
      renderSpecCard(contract(), PASS_GATE, OPTS).keyboard,
      renderEvidenceCard(evidence()).keyboard,
      renderEvidenceCard(evidence({ notVerified: ["x"] })).keyboard,
    ];
    const seen = new Set<string>();
    for (const kb of kbs) {
      for (const b of buttons(kb)) {
        if (b.callback_data === undefined) continue;
        const p = parseCodingCallback(b.callback_data);
        expect(p).not.toBeNull();
        expect(p?.nonce).toBe("abc123");
        seen.add(p?.action ?? "");
      }
    }
    expect(Array.from(seen).sort()).toEqual(["approve", "cancel", "change", "merge", "merge_ack"]);
  });

  it("parses the documented format", () => {
    expect(parseCodingCallback("cp:approve:abc")).toEqual({ action: "approve", nonce: "abc" });
    expect(parseCodingCallback("cp:merge_ack:a-b_9")).toEqual({ action: "merge_ack", nonce: "a-b_9" });
  });

  it.each([
    "",
    "approve:abc",
    "cp:approve",
    "cp:approve:",
    "cp:unknown:abc",
    "cp:Approve:abc",
    "cp:approve:abc:def",
    "cp:approve:a b",
    "cp:approve:" + "x".repeat(33),
    "cp:merge_ack:" + "x".repeat(60),
    "cp:approve:abc\n",
    "xcp:approve:abc",
    "cp:approve:é",
  ])("rejects %j", (bad) => {
    expect(parseCodingCallback(bad)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseCodingCallback(undefined as unknown as string)).toBeNull();
    expect(parseCodingCallback(42 as unknown as string)).toBeNull();
  });
});
