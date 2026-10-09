/**
 * Coding-pipeline cards: the merge card the founder decides on.
 * Pure renderers, no Telegram client. Every assertion is about what the founder sees or
 * can tap, because a hidden reason or a wrong button is the failure this file exists to stop.
 */
import { describe, it, expect } from "vitest";
import type { InlineKeyboard } from "grammy";
import {
  renderEvidenceCard,
  parseCodingCallback,
  TELEGRAM_HTML_LIMIT,
  type EvidenceCardInput,
} from "../../../src/gateway/coding-cards.js";

/** Angle brackets are built, not typed, so the raw markup an attacker would send is explicit. */
const LT = String.fromCharCode(60);
const QUOT = String.fromCharCode(34);

type Verdict = { status: "PASS" | "FAIL" | "UNKNOWN"; reasons: string[] };
const P: Verdict = { status: "PASS", reasons: [] };

function evidence(over: Partial<EvidenceCardInput> = {}): EvidenceCardInput {
  const base: EvidenceCardInput = {
    ci: P,
    review: { decision: "APPROVE", findings: [] },
    merge: { ok: true, reasons: [] },
    prUrl: "https://github.com/acme/widgets/pull/9",
    nonce: "abc123",
    subject: { repo: "acme/widgets", pr: 9, issue: 12, title: "Fix the health check" },
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

describe("renderEvidenceCard", () => {
  it("all green offers [Merge] and an Open PR url button", () => {
    const { html, keyboard } = renderEvidenceCard(evidence());
    const h = joined(html);
    expect(h).toContain("Required CI: ✓ PASS");
    expect(h).toContain("Gate: ✓ PASS");
    expect(h).toContain("Review: ✓ PASS");
    const b = buttons(keyboard);
    expect(b.find((x) => x.callback_data === "cp:merge:abc123")?.text).toContain("Merge");
    expect(b.find((x) => x.url)?.url).toBe("https://github.com/acme/widgets/pull/9");
    expect(b.filter((x) => x.callback_data)).toHaveLength(1);
  });

  it("opens with the repo, PR number, issue number and PR title, so the card names what it is about", () => {
    const first = renderEvidenceCard(evidence()).html[0]!.split("\n")[0]!;
    expect(first).toBe("<b>Ready to merge?</b> acme/widgets#9 (issue #12): Fix the health check");
  });

  it("escapes the PR title and keeps it on one line", () => {
    const title = LT + "script>alert(1)" + LT + "/script>\nsecond line";
    const first = renderEvidenceCard(evidence({ subject: { repo: "acme/widgets", pr: 9, issue: 12, title } })).html[0]!.split("\n")[0]!;
    expect(first).not.toContain(LT + "script");
    expect(first).toContain("&lt;script&gt;");
    expect(first).toContain("second line");
  });

  it("a PR with no title still names itself", () => {
    const first = renderEvidenceCard(evidence({ subject: { repo: "acme/widgets", pr: 9, issue: 12, title: "  " } })).html[0]!.split("\n")[0]!;
    expect(first).toBe("<b>Ready to merge?</b> acme/widgets#9 (issue #12): (no title)");
  });

  it("null review is ? UNKNOWN, never a tick, and offers no merge", () => {
    const { html, keyboard } = renderEvidenceCard(evidence({ review: null }));
    const h = joined(html);
    expect(h).toContain("Review: ? UNKNOWN");
    expect(h).not.toContain("Review: ✓");
    expect(hasMerge(keyboard)).toBe(false);
  });

  const nonPass: Array<[string, Partial<EvidenceCardInput>]> = [
    ["ci FAIL", { ci: { status: "FAIL", reasons: ["required check failed: gate"] } }],
    ["ci UNKNOWN", { ci: { status: "UNKNOWN", reasons: ["required checks have no result yet: gate"] } }],
    ["review null", { review: null }],
    ["review UNKNOWN", { review: { decision: "UNKNOWN", findings: [] } }],
    ["review REQUEST_CHANGES", { review: { decision: "REQUEST_CHANGES", findings: [{ severity: "blocker", claim: "bad" }] } }],
    ["merge not ok", { merge: { ok: false, reasons: ["head moved"] } }],
    ["merge ok undefined", { merge: { ok: undefined as unknown as boolean, reasons: [] } }],
    ["merge ok truthy string", { merge: { ok: "true" as unknown as boolean, reasons: [] } }],
    ["bogus lowercase status", { ci: { status: "pass" as "PASS", reasons: [] } }],
  ];
  it.each(nonPass)("%s: no merge button", (_n, over) => {
    const { keyboard } = renderEvidenceCard(evidence(over));
    expect(hasMerge(keyboard)).toBe(false);
    expect(buttons(keyboard).some((b) => b.url)).toBe(true);
  });

  it("non-PASS rows list every reason, with the right mark", () => {
    const h = joined(
      renderEvidenceCard(
        evidence({
          ci: { status: "FAIL", reasons: ["r-one", "r-two"] },
          review: { decision: "UNKNOWN", findings: [] },
          merge: { ok: false, reasons: ["r-four"] },
        }),
      ).html,
    );
    expect(h).toContain("Required CI: ✗ FAIL");
    expect(h).toContain("Review: ? UNKNOWN");
    expect(h).toContain("Gate: ✗ FAIL");
    for (const r of ["r-one", "r-two", "r-four"]) expect(h).toContain(r);
  });

  it("a non-PASS verdict with no reasons still says so", () => {
    const h = joined(renderEvidenceCard(evidence({ ci: { status: "FAIL", reasons: [] } })).html);
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

  it("merge.ok true while a row is not PASS is called out, not trusted", () => {
    const { html, keyboard } = renderEvidenceCard(evidence({ ci: { status: "FAIL", reasons: ["ci red"] } }));
    expect(joined(html)).toMatch(new RegExp("inconsistent", "i"));
    expect(hasMerge(keyboard)).toBe(false);
  });

  it("escapes HTML in reasons and findings", () => {
    const findings = [{ severity: "major", claim: LT + "i>x", file: LT + "u>.ts" }];
    const h = joined(
      renderEvidenceCard(
        evidence({
          ci: { status: "FAIL", reasons: [LT + "b>bold" + LT + "b> & more", LT + "a href=x"] },
          review: { decision: "REQUEST_CHANGES", findings },
        }),
      ).html,
    );
    for (const tag of ["b>bold", "i>x", "u>.ts", "a href"]) expect(h).not.toContain(LT + tag);
    expect(h).toContain("&lt;b&gt;bold&lt;b&gt; &amp; more");
  });

  it("60 long reasons all appear across parts, each part under the Telegram limit", () => {
    const reasons = Array.from({ length: 60 }, (_, i) => "reason-" + i + "-" + "x".repeat(200));
    const { html } = renderEvidenceCard(evidence({ ci: { status: "FAIL", reasons } }));
    expect(html.length).toBeGreaterThan(1);
    for (const part of html) expect(part.length).toBeLessThan(TELEGRAM_HTML_LIMIT);
    const h = joined(html);
    for (let i = 0; i < 60; i++) expect(h).toContain("reason-" + i + "-");
  });

  it("one 10k-char reason is split, not truncated", () => {
    const reason = "q".repeat(10000);
    const { html } = renderEvidenceCard(evidence({ ci: { status: "FAIL", reasons: [reason] } }));
    for (const part of html) expect(part.length).toBeLessThan(TELEGRAM_HTML_LIMIT);
    expect(count(joined(html), "q")).toBeGreaterThanOrEqual(10000);
  });

  it("a split never cuts an HTML entity or leaves a tag open", () => {
    const reason = (LT + "" + String.fromCharCode(62) + "&" + QUOT).repeat(2000);
    const { html } = renderEvidenceCard(evidence({ ci: { status: "FAIL", reasons: [reason] } }));
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
        ci: { status: "FAIL", reasons: mk("C") },
        merge: { ok: false, reasons: mk("M") },
        review: { decision: "REQUEST_CHANGES", findings: mk("R").map((claim) => ({ severity: "blocker", claim })) },
      }),
    );
    const h = joined(html);
    for (const tag of ["C", "M", "R"]) for (let i = 0; i < 25; i++) expect(h).toContain(tag + i + "-");
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
    const b = buttons(renderEvidenceCard(evidence({ nonce })).keyboard).filter((x) => x.callback_data !== undefined);
    expect(b).toHaveLength(1);
    for (const x of b) expect(Buffer.byteLength(x.callback_data!, "utf8")).toBeLessThanOrEqual(64);
    for (const action of ["merge", "fix", "close_pr"]) expect(Buffer.byteLength("cp:" + action + ":" + nonce, "utf8")).toBeLessThanOrEqual(64);
  });

  it("every rendered callback parses back to its action and nonce", () => {
    const b = buttons(renderEvidenceCard(evidence()).keyboard).filter((x) => x.callback_data !== undefined);
    expect(b.map((x) => parseCodingCallback(x.callback_data))).toEqual([{ action: "merge", nonce: "abc123" }]);
  });

  it("parses the documented format", () => {
    expect(parseCodingCallback("cp:merge:abc")).toEqual({ action: "merge", nonce: "abc" });
    expect(parseCodingCallback("cp:close_pr:a-b_9")).toEqual({ action: "close_pr", nonce: "a-b_9" });
  });

  it.each([
    "",
    "merge:abc",
    "cp:merge",
    "cp:merge:",
    "cp:unknown:abc",
    "cp:Merge:abc",
    "cp:merge:abc:def",
    "cp:merge:a b",
    "cp:merge:" + "x".repeat(33),
    "cp:fix:" + "x".repeat(60),
    "cp:merge:abc\n",
    "xcp:merge:abc",
    "cp:merge:é",
    // The spec card and its buttons are gone (AG-062): an old card's tap is out of date, not acted on.
    "cp:approve:abc",
    "cp:change:abc",
    "cp:cancel:abc",
    "cp:merge_ack:abc",
  ])("rejects %j", (bad) => {
    expect(parseCodingCallback(bad)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseCodingCallback(undefined as unknown as string)).toBeNull();
    expect(parseCodingCallback(42 as unknown as string)).toBeNull();
  });
});
