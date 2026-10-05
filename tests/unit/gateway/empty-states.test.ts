/**
 * P2-3 (docs/plans/2026-10-04-telegram-ux-audit.md, F24): "no focus set - send /focus <text>"
 * is a dead end. Each empty state gives one example the founder can tap (Telegram copies
 * the text of a <code> span on tap), edit and send.
 */

import { describe, it, expect } from "vitest";
import { EMPTY_STATE_EXAMPLES, emptyStateHtml, type EmptyStateKind } from "../../../src/gateway/empty-states.js";

const KINDS: readonly EmptyStateKind[] = ["focus", "projects", "remind"];

describe("emptyStateHtml", () => {
  for (const kind of KINDS) {
    it(`${kind}: says nothing is set and shows exactly one tappable example`, () => {
      const html = emptyStateHtml(kind);
      expect(html.match(/<code>/g)).toHaveLength(1);
      expect(html).toContain(`<code>${EMPTY_STATE_EXAMPLES[kind]}</code>`);
      expect(EMPTY_STATE_EXAMPLES[kind].startsWith(`/${kind} `)).toBe(true);
    });

    it(`${kind}: the example carries no characters that break Telegram HTML`, () => {
      expect(EMPTY_STATE_EXAMPLES[kind]).not.toMatch(/[<>&]/);
    });
  }

  it("projects: the example holds two projects split by a semicolon, as the command expects", () => {
    const names = EMPTY_STATE_EXAMPLES.projects.replace("/projects ", "").split(";").map((n) => n.trim());
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.every((n) => n !== "")).toBe(true);
  });

  it("tells the founder to tap to copy, edit, then send", () => {
    expect(emptyStateHtml("focus")).toMatch(/Tap/);
  });
});
