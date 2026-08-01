/**
 * Unit tests — the brief must survive its own content.
 *
 * `sendToChat` defaults to parse_mode "HTML". Real job titles carry "&" and "<"
 * ("Bloom & Wild Group" appeared in the 2026-07-31 prod run), and Telegram
 * rejects the whole message when it cannot parse the entities.
 *
 * The failure is worse than it looks: the brief send is wrapped in a catch that
 * ALSO sends with the same parse mode, so a single "<" in a job title means the
 * founder receives nothing at all while the sweep logs success.
 */

import { describe, it, expect } from "vitest";
import { toTelegramSafe } from "../../../src/tools/jobhunt/brief.js";

describe("toTelegramSafe", () => {
  it("escapes the characters Telegram's HTML parser chokes on", () => {
    expect(toTelegramSafe("Bloom & Wild Group")).toBe("Bloom &amp; Wild Group");
    expect(toTelegramSafe("Engineer <Senior>")).toBe("Engineer &lt;Senior&gt;");
  });

  it("escapes the ampersand FIRST so an escape is not double-escaped", () => {
    // "&" → "&amp;" must not then turn "&lt;" into "&amp;lt;".
    expect(toTelegramSafe("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("leaves the brief's own symbols alone", () => {
    const line = "▸ DO TODAY (3)  · overlap 8/17 — verified live → /draft 1  ⚠";
    expect(toTelegramSafe(line)).toBe(line);
  });

  it("is a no-op on text with nothing to escape", () => {
    expect(toTelegramSafe("Senior Platform Engineer")).toBe("Senior Platform Engineer");
  });
});
