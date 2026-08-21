/**
 * Unit tests — one stray "<" must not cost the founder the whole brief.
 *
 * WHAT HAPPENED. On 2026-08-21 `/jobs` failed for every invocation with
 * `400: can't parse entities: Unsupported start tag "" at byte offset 177`.
 * Byte 177 was the literal "(< 24h old)" in the brief header — a `<` followed
 * by a space, which Telegram reads as an empty tag name and rejects.
 *
 * The severity is the point. Telegram does not drop the offending character or
 * the offending row; it refuses the ENTIRE sendMessage. A 16 KB shortlist,
 * correct in every other respect, became nothing at all because of one byte
 * that a human wrote as punctuation.
 *
 * `esc()` already covers every value interpolated from a company, a title or a
 * gate. It cannot cover this class, because this `<` is in the literal template
 * — written by us, and therefore "trusted by construction" right up until it
 * wasn't. `escapeStrayAngles` is the backstop for that: markup we actually
 * emit passes through untouched, and anything else becomes text.
 */

import { describe, it, expect } from "vitest";
import { escapeStrayAngles } from "../../../src/tools/jobhunt/telegram-format.js";
import { formatDailyBrief, type BriefInput } from "../../../src/tools/jobhunt/brief.js";

describe("escapeStrayAngles — leaves real markup alone", () => {
  it("passes through the tags the brief actually emits", () => {
    const html = "<b>Bold</b> <i>italic</i> <code>/draft 1</code>";
    expect(escapeStrayAngles(html)).toBe(html);
  });

  it("passes through an anchor with an href attribute", () => {
    const html = '<a href="https://example.com/jobs?a=1&amp;b=2">Adyen</a>';
    expect(escapeStrayAngles(html)).toBe(html);
  });

  it("passes through the multi-word tags Telegram allows", () => {
    const html = "<tg-spoiler>hidden</tg-spoiler><blockquote>quoted</blockquote>";
    expect(escapeStrayAngles(html)).toBe(html);
  });

  it("does not touch an already-escaped entity", () => {
    // Double-escaping would print "&amp;lt;" at the founder — the same class of
    // bug in the opposite direction.
    expect(escapeStrayAngles("/draft &lt;n&gt;")).toBe("/draft &lt;n&gt;");
  });
});

describe("escapeStrayAngles — neutralises what Telegram would reject", () => {
  it("escapes the exact byte that killed /jobs", () => {
    const header = "<i>9 fresh roles in the queue (< 24h old)</i>";
    expect(escapeStrayAngles(header)).toBe("<i>9 fresh roles in the queue (&lt; 24h old)</i>");
  });

  it("escapes a tag name Telegram does not support", () => {
    // A company writing "<script>" into a job title is data, not markup.
    expect(escapeStrayAngles("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes a bare comparison written in prose", () => {
    expect(escapeStrayAngles("pay < 52284 EUR")).toBe("pay &lt; 52284 EUR");
  });

  it("escapes a dangling angle at the very end of a message", () => {
    // The split boundary is where a truncated tag would land.
    expect(escapeStrayAngles("salary band <")).toBe("salary band &lt;");
  });

  it("keeps the good tags and escapes only the bad one in the same string", () => {
    expect(escapeStrayAngles("<b>Ockto</b> pays < 52k")).toBe("<b>Ockto</b> pays &lt; 52k");
  });

  it("is idempotent — running it twice changes nothing further", () => {
    const once = escapeStrayAngles("<b>x</b> a < b");
    expect(escapeStrayAngles(once)).toBe(once);
  });
});

describe("the rendered brief is already clean", () => {
  /** The real renderer, on a shape that exercises the header the bug lived in. */
  function brief(): string {
    const input: BriefInput = {
      date: new Date("2026-08-21T06:00:00Z"),
      screened: 85,
      perTrack: { ai: 1, backend: 8, frontend: 3 },
      rows: [],
      trends: [],
      failures: [],
      maxAgeHours: 24,
      agedOut: 468,
    };
    return formatDailyBrief(input);
  }

  it("emits no angle bracket Telegram would reject", () => {
    // This is the regression guard, not the sanitiser: the brief should be
    // correct at the source, and the sanitiser is the net under it.
    const rendered = brief();
    expect(escapeStrayAngles(rendered)).toBe(rendered);
  });

  it("still says how old a fresh role is — the fix is escaping, not deleting", () => {
    expect(brief()).toContain("24h old");
  });
});
