/**
 * Unit tests — Telegram rendering primitives.
 *
 * These guard the two failure modes that cost the founder the WHOLE message
 * rather than degrading one row: an unparseable entity, and a body over the
 * 4,096-character limit. Both are rejected by Telegram outright, and the sweep
 * logs success either way.
 */

import { describe, it, expect } from "vitest";
import {
  esc,
  link,
  cmd,
  splitForTelegram,
  TELEGRAM_MAX_CHARS,
} from "../../../src/tools/jobhunt/telegram-format.js";

describe("esc", () => {
  it("escapes the characters Telegram parses as entities", () => {
    // "Bloom & Wild Group" arrived in the 2026-07-31 production sweep.
    expect(esc("Bloom & Wild Group")).toBe("Bloom &amp; Wild Group");
    expect(esc("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes the ampersand first, so an escape is never double-escaped", () => {
    // Escaping "<" before "&" would turn "&lt;" into "&amp;lt;" and print the
    // escape sequence at the founder instead of the character.
    expect(esc("a < b & c")).toBe("a &lt; b &amp; c");
  });
});

describe("link", () => {
  it("wraps the label in an anchor when the URL is usable", () => {
    expect(link("Senior Engineer", "https://jobs.example.com/1")).toBe(
      '<a href="https://jobs.example.com/1">Senior Engineer</a>',
    );
  });

  it("returns a bare escaped label when there is no URL", () => {
    expect(link("R&D Engineer", null)).toBe("R&amp;D Engineer");
  });

  it("drops the link rather than the message when the URL is unusable", () => {
    // A malformed href makes Telegram reject the entire message. One bad row
    // must cost its own link, never the founder's whole brief.
    expect(link("Engineer", "not a url")).toBe("Engineer");
    expect(link("Engineer", "javascript:alert(1)")).toBe("Engineer");
  });

  it("escapes the label inside the anchor", () => {
    expect(link("Data & AI Lead", "https://x.test/j")).toBe(
      '<a href="https://x.test/j">Data &amp; AI Lead</a>',
    );
  });
});

describe("cmd", () => {
  it("renders a tap-to-copy code span", () => {
    // <code> is functional, not decorative: tapping it copies the command.
    expect(cmd("/draft 1")).toBe("<code>/draft 1</code>");
  });
});

describe("splitForTelegram", () => {
  it("returns a single part when the message fits", () => {
    expect(splitForTelegram("short message")).toEqual(["short message"]);
  });

  it("splits an over-long message and keeps every part within the limit", () => {
    const block = "x".repeat(500);
    const text = Array.from({ length: 20 }, () => block).join("\n\n");
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_CHARS);

    const parts = splitForTelegram(text);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it("loses no content when splitting", () => {
    const text = Array.from({ length: 30 }, (_, i) => `block ${i} ${"y".repeat(300)}`).join("\n\n");
    const rejoined = splitForTelegram(text).join("\n\n");
    expect(rejoined).toBe(text);
  });

  it("never ends a part inside an HTML tag", () => {
    // Every tag this renderer emits opens and closes within one line, so a
    // line-boundary split is entity-safe. A part with unbalanced tags would make
    // Telegram reject it — the exact failure chunking exists to prevent.
    const row = "<b>Company</b> — <a href=\"https://x.test/j\">Some Engineer Role</a>";
    const text = Array.from({ length: 120 }, () => row).join("\n\n");

    for (const part of splitForTelegram(text)) {
      const opens = (part.match(/<b>/g) ?? []).length;
      const closes = (part.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
      expect((part.match(/<a /g) ?? []).length).toBe((part.match(/<\/a>/g) ?? []).length);
    }
  });

  it("truncates a single line longer than the limit rather than dropping the rest", () => {
    const parts = splitForTelegram(`${"z".repeat(TELEGRAM_MAX_CHARS + 200)}\n\ntail`, TELEGRAM_MAX_CHARS);
    expect(parts[0]!.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(parts.at(-1)).toContain("tail");
  });
});
