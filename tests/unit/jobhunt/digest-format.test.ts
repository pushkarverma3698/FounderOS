/**
 * The digest's apply-first layout: ranking, the nudge line, message splitting and the button payloads.
 * All pure, so each test is an array literal.
 */
import { describe, it, expect } from "vitest";
import {
  DIGEST_APPLY_BUTTONS,
  DIGEST_MESSAGE_MAX_CHARS,
  applyKeyboard,
  buildPersonMessages,
  nudgeLine,
  rankRoles,
  type DigestRole,
} from "../../../src/tools/jobhunt/digest-format.js";
import { parseJobCallback } from "../../../src/gateway/jobhunt-buttons.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const role = (n: number, extra: Partial<DigestRole> = {}): DigestRole => ({
  key: "k" + n,
  company: "Co" + n,
  title: "Finance Controller",
  url: "https://example.com/" + n,
  outcome: "pass",
  rowId: uuid(n),
  section: null,
  fit: null,
  ...extra,
});
const who = { name: "Tashi", selector: "tashi" };

describe("rankRoles", () => {
  it("leads with do_today, then other passing roles by fit, then flagged ones; stable otherwise", () => {
    const ranked = rankRoles([
      role(1, { outcome: "flag" }),
      role(2, { fit: 0.4 }),
      role(3, { section: "do_today", fit: 0.2 }),
      role(4, { fit: 0.9 }),
      role(5, { section: "do_today", fit: 0.8 }),
      role(6),
    ]);
    expect(ranked.map((r) => r.key)).toEqual(["k5", "k3", "k4", "k2", "k6", "k1"]);
  });
});

describe("nudgeLine", () => {
  it("states applied this week and the open do-today count", () => {
    expect(nudgeLine({ appliedWeek: 2, openDoToday: 9 })).toBe("Applied this week: 2 · open do-today roles: 9");
  });
  it("drops the open count when there are none, and is empty with no stats", () => {
    expect(nudgeLine({ appliedWeek: 0, openDoToday: 0 })).toBe("Applied this week: 0");
    expect(nudgeLine(null)).toBe("");
  });
});

describe("applyKeyboard", () => {
  it("gives each top role Draft, Applied and Skip buttons that carry THAT role's row id", () => {
    const kb = applyKeyboard([role(1), role(2)]);
    expect(kb.length).toBe(2);
    for (const [i, row] of kb.entries()) {
      const parsed = row.map((b) => parseJobCallback(b.callback_data));
      expect(parsed.map((p) => p?.action)).toEqual(["draft", "applied", "skipped"]);
      for (const p of parsed) expect(p?.rowId).toBe(uuid(i + 1));
      for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
  });
  it("skips roles with no stored row: a button without an id would be a guess", () => {
    expect(applyKeyboard([role(1, { rowId: null })])).toEqual([]);
  });
});

describe("buildPersonMessages", () => {
  it("opens with the name, the nudge and the numbered top roles, buttons only on that message", () => {
    const msgs = buildPersonMessages({
      ...who,
      roles: Array.from({ length: 9 }, (_, i) => role(i + 1)),
      overflow: 0,
      backfill: 0,
      stats: { appliedWeek: 2, openDoToday: 9 },
    });
    expect(msgs[0]?.text).toContain("Tashi");
    expect(msgs[0]?.text).toContain("9 new roles");
    expect(msgs[0]?.text).toContain("Applied this week: 2 · open do-today roles: 9");
    expect(msgs[0]?.text).toContain("1. ");
    expect(msgs[0]?.keyboard?.length).toBe(DIGEST_APPLY_BUTTONS);
    expect(msgs.slice(1).every((m) => m.keyboard === undefined)).toBe(true);
  });

  it("names EVERY role, splitting into more messages instead of hiding any (4096-char limit)", () => {
    const roles = Array.from({ length: 50 }, (_, i) => role(i + 1, { title: "Senior Financial Controller Operations " + "x".repeat(60) }));
    const msgs = buildPersonMessages({ ...who, roles, overflow: 0, backfill: 0, stats: null });
    expect(msgs.length).toBeGreaterThan(2);
    const all = msgs.map((m) => m.text).join("\n");
    for (let i = 1; i <= 50; i++) expect(all).toContain(`https://example.com/${i}"`);
    for (const m of msgs) {
      expect(m.text.length).toBeLessThanOrEqual(DIGEST_MESSAGE_MAX_CHARS);
      expect(m.text).toContain("Tashi");
    }
  });

  it("counts roles past the buffer cap and points to /jobs with the selector", () => {
    const msgs = buildPersonMessages({ ...who, roles: [role(1)], overflow: 7, backfill: 0, stats: null });
    const all = msgs.map((m) => m.text).join("\n");
    expect(all).toContain("8 new roles");
    expect(all).toMatch(/7 more[^\n]*\/jobs tashi/);
  });

  it("escapes company and title text", () => {
    const msgs = buildPersonMessages({ ...who, roles: [role(1, { company: "A & <B>" })], overflow: 0, backfill: 0, stats: null });
    expect(msgs[0]?.text).toContain("A &amp; &lt;B&gt;");
  });

  it("reports a backfill-only buffer without buttons", () => {
    const msgs = buildPersonMessages({ ...who, roles: [], overflow: 0, backfill: 4, stats: null });
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.text).toContain("4 older roles");
    expect(msgs[0]?.keyboard).toBeUndefined();
  });
});
