import { describe, expect, it } from "vitest";
import { renderBlockedCard, type BlockedCardInput } from "../../../src/gateway/blocked-card.js";
import { parseCodingCallback } from "../../../src/gateway/coding-cards.js";

const blockers = [
  { severity: "blocker" as const, file: "test/auth-flows.test.js", line: 244, claim: "The test expects 404 where the route returns 401", evidence: "node --test: 1 failing" },
  { severity: "blocker" as const, file: "test/new.test.ts", claim: "A vitest file in a repo that runs node --test", evidence: "package.json test script" },
];

const base: BlockedCardInput = {
  repo: "OplifyMessage/api",
  pr: 116,
  issue: 115,
  title: "feat: auth flows <draft>",
  branch: "task/issue-115-auth",
  baseRef: "beta",
  blockers,
  otherCount: 1,
  url: "https://github.com/OplifyMessage/api/pull/116",
  nonce: "Nn0_abcDEF123456",
};

const buttons = (c: ReturnType<typeof renderBlockedCard>): { text: string; callback_data?: string; url?: string }[] =>
  c.keyboard.inline_keyboard.flat() as { text: string; callback_data?: string; url?: string }[];

describe("renderBlockedCard", () => {
  it("lists every blocker in plain words, with where and the evidence", () => {
    const text = renderBlockedCard(base).html.join("\n");
    expect(text).toContain("PR #116");
    expect(text).toContain("2 blockers");
    expect(text).toContain("1. The test expects 404 where the route returns 401");
    expect(text).toContain("test/auth-flows.test.js:244");
    expect(text).toContain("node --test: 1 failing");
    expect(text).toContain("2. A vitest file in a repo that runs node --test");
    expect(text).toContain("test/new.test.ts");
    expect(text).toContain("1 non-blocking note");
  });

  it("escapes the PR title and the reviewer's words", () => {
    const text = renderBlockedCard(base).html.join("\n");
    expect(text).toContain("feat: auth flows &lt;draft&gt;");
    expect(text).not.toContain("<draft>");
  });

  it("offers Fix now and Close PR as cp: buttons the callback parser reads, plus a link", () => {
    const b = buttons(renderBlockedCard(base));
    const fix = b.find((x) => x.text.includes("Fix now"));
    const close = b.find((x) => x.text.includes("Close PR"));
    expect(parseCodingCallback(fix?.callback_data)).toEqual({ action: "fix", nonce: base.nonce });
    expect(parseCodingCallback(close?.callback_data)).toEqual({ action: "close_pr", nonce: base.nonce });
    expect(b.some((x) => x.url === base.url)).toBe(true);
  });

  it("says what each button does, on the same branch", () => {
    const text = renderBlockedCard(base).html.join("\n");
    expect(text).toContain("task/issue-115-auth");
    expect(text).toMatch(/Fix now/);
    expect(text).toMatch(/Close PR/);
  });

  it("without a linked issue there is no Fix now button, and the card says how to fix it", () => {
    const c = renderBlockedCard({ ...base, issue: undefined });
    expect(buttons(c).some((x) => x.text.includes("Fix now"))).toBe(false);
    expect(buttons(c).some((x) => x.text.includes("Close PR"))).toBe(true);
    expect(c.html.join("\n")).toContain("not linked to an issue");
  });

  it("splits a long card across messages and never drops a blocker", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ severity: "blocker" as const, claim: `claim ${i} ` + "x".repeat(380), evidence: "e".repeat(230) }));
    const c = renderBlockedCard({ ...base, blockers: many });
    for (const part of c.html) expect(part.length).toBeLessThan(4096);
    const all = c.html.join("\n");
    expect(all).toContain("claim 0 ");
    expect(all).toContain("claim 11 ");
  });

  it("refuses a non-https PR link and a bad nonce", () => {
    expect(() => renderBlockedCard({ ...base, url: "http://x" })).toThrow();
    expect(() => renderBlockedCard({ ...base, nonce: "bad nonce!" })).toThrow();
  });
});
