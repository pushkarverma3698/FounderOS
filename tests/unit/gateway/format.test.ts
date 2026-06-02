/**
 * Unit tests for Telegram message formatting.
 *
 * Why this exists: the office LLM emits Markdown (**bold**, bullets, `code`,
 * headings). The old gateway HTML-escaped the whole string, so Telegram showed
 * raw asterisks ("* **Google Security Alerts**") — the "low grade" replies.
 *
 * markdownToTelegramHtml converts Markdown → the small HTML subset Telegram's
 * Bot API supports (<b> <i> <code> <pre> <a>), escaping literal text safely.
 * splitForTelegram chunks long output under Telegram's 4096-char hard limit
 * without cutting words or breaking HTML tags across messages.
 *
 * RED: these fail until src/gateway/format.ts exists.
 */

import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, splitForTelegram } from "../../../src/gateway/format.js";

describe("markdownToTelegramHtml", () => {
  it("converts **bold** to <b>", () => {
    expect(markdownToTelegramHtml("**Google Security Alerts**")).toBe("<b>Google Security Alerts</b>");
  });

  it("converts *italic* and _italic_ to <i>", () => {
    expect(markdownToTelegramHtml("_quietly_")).toBe("<i>quietly</i>");
  });

  it("converts `inline code` to <code>", () => {
    expect(markdownToTelegramHtml("run `pnpm test`")).toBe("run <code>pnpm test</code>");
  });

  it("converts a ```fenced block``` to <pre>", () => {
    expect(markdownToTelegramHtml("```\nconst x = 1;\n```")).toBe("<pre>const x = 1;</pre>");
  });

  it("converts markdown bullets to • bullets", () => {
    const out = markdownToTelegramHtml("* First item\n* Second item");
    expect(out).toBe("• First item\n• Second item");
  });

  it("also handles dash bullets", () => {
    expect(markdownToTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  it("converts # headings to bold lines", () => {
    expect(markdownToTelegramHtml("## Summary")).toBe("<b>Summary</b>");
  });

  it("converts [text](url) links to <a> tags", () => {
    expect(markdownToTelegramHtml("[docs](https://x.com)")).toBe('<a href="https://x.com">docs</a>');
  });

  it("escapes raw HTML-significant characters in plain text", () => {
    expect(markdownToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("does NOT escape the markup it generates (round-trips to valid Telegram HTML)", () => {
    const out = markdownToTelegramHtml("**bold** and `x>y`");
    expect(out).toBe("<b>bold</b> and <code>x&gt;y</code>");
  });

  it("leaves plain prose untouched", () => {
    expect(markdownToTelegramHtml("Just a normal sentence.")).toBe("Just a normal sentence.");
  });

  it("handles a realistic multi-line email brief", () => {
    const md = "Here's your brief:\n\n**Google Security Alerts (5)**\n- New sign-in detected\n- Review activity";
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<b>Google Security Alerts (5)</b>");
    expect(out).toContain("• New sign-in detected");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^- /m);
  });
});

describe("splitForTelegram", () => {
  it("returns a single chunk when under the limit", () => {
    expect(splitForTelegram("short message", 4096)).toEqual(["short message"]);
  });

  it("splits long text into multiple chunks under the limit", () => {
    const line = "x".repeat(500);
    const text = Array.from({ length: 20 }, () => line).join("\n"); // ~10k chars
    const chunks = splitForTelegram(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });

  it("prefers splitting on paragraph/line boundaries, not mid-word", () => {
    const para = "word ".repeat(900).trim(); // ~4500 chars, spaces between words
    const chunks = splitForTelegram(para, 4096);
    expect(chunks.length).toBe(2);
    // no chunk should end with a partial word (i.e. ends on a complete token)
    for (const c of chunks) expect(c).not.toMatch(/\Sword$/);
  });

  it("hard-splits a single token longer than the limit", () => {
    const giant = "y".repeat(9000);
    const chunks = splitForTelegram(giant, 4096);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });

  it("never emits an empty chunk", () => {
    const chunks = splitForTelegram("\n\n\nhello\n\n\n", 4096);
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });
});
