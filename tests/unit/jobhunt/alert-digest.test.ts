/**
 * New-role alerts go out in batches, three a day, not one message per sweep.
 *
 * THE BUG. The free lane sweeps 48 times a day and a message went to the family jobs group every time a sweep
 * found something, plus an alive ping every 3 hours and the funnel alert. The group was a ticker. The batch
 * is the fix: sweeps buffer, a slot sends, and the count of group messages a day is a property of the slot
 * list, not of how busy the market was.
 */

import { describe, it, expect } from "vitest";
import {
  DIGEST_HOURS,
  digestDue,
  digestSlotKey,
  mergePending,
  sendDueDigest,
  EMPTY_PENDING,
  type DigestDeps,
  type DigestKeyboard,
  type DigestState,
} from "../../../src/tools/jobhunt/alert-digest.js";
import { DEFAULT_PROFILE_ID, getProfile } from "../../../src/tools/jobhunt/profile-config.js";

const TZ = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);
const WIFE_ID = "wife-nl-finance";
/** A valid uuid made from a key, stable per key. */
const UUID_OF = (key: string): string => {
  const hex = Buffer.from(key).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

function row(company: string, outcome: "pass" | "flag" = "pass") {
  const key = company.toLowerCase() + "::finance controller";
  const url = "https://example.com/" + company;
  return { company, title: "Finance Controller", outcome, url, key };
}

describe("the three daily slots", () => {
  it("are 09:00, 14:00 and 19:00 in the app timezone", () => {
    expect(DIGEST_HOURS).toEqual([9, 14, 19]);
  });

  it("number the slot a moment falls in, and none before the first one", () => {
    expect(digestSlotKey(at("2026-10-05T02:00:00Z"), TZ)).toBe("2026-10-05#0");
    expect(digestSlotKey(at("2026-10-05T04:00:00Z"), TZ)).toBe("2026-10-05#1");
    expect(digestSlotKey(at("2026-10-05T09:00:00Z"), TZ)).toBe("2026-10-05#2");
    expect(digestSlotKey(at("2026-10-05T14:00:00Z"), TZ)).toBe("2026-10-05#3");
  });

  it("is due once per slot, whatever time inside the slot the sweep runs", () => {
    expect(digestDue(null, at("2026-10-05T02:00:00Z"), TZ)).toBe(false);
    expect(digestDue(null, at("2026-10-05T04:00:00Z"), TZ)).toBe(true);
    expect(digestDue(at("2026-10-05T04:00:00Z"), at("2026-10-05T04:30:00Z"), TZ)).toBe(false);
    expect(digestDue(at("2026-10-05T04:00:00Z"), at("2026-10-05T09:00:00Z"), TZ)).toBe(true);
  });

  it("stays quiet overnight and fires again at the first slot of the next day", () => {
    const evening = at("2026-10-05T14:00:00Z");
    expect(digestDue(evening, at("2026-10-05T20:00:00Z"), TZ)).toBe(false);
    expect(digestDue(evening, at("2026-10-06T02:00:00Z"), TZ)).toBe(false);
    expect(digestDue(evening, at("2026-10-06T04:00:00Z"), TZ)).toBe(true);
  });
});

describe("mergePending", () => {
  it("adds rows and backfill, and never lists the same role twice", () => {
    const first = mergePending(EMPTY_PENDING, [row("Nexperia")], 2);
    const second = mergePending(first, [row("Nexperia"), row("Bosch")], 3);
    expect(second.rows.map((r) => r.company)).toEqual(["Nexperia", "Bosch"]);
    expect(second.backfill).toBe(5);
  });

  it("counts the rows past the cap instead of dropping them silently", () => {
    const many = Array.from({ length: 70 }, (_, i) => row("Company" + i));
    const merged = mergePending(EMPTY_PENDING, many, 0);
    expect(merged.rows.length + merged.overflow).toBe(70);
    expect(merged.overflow).toBeGreaterThan(0);
  });
});

/** An in-memory stand-in for job_digest_state, and the list of messages the group would have received. */
function harness(profileIds: readonly string[]) {
  const store = new Map<string, DigestState>();
  const sent: string[] = [];
  const keyboards: (DigestKeyboard | undefined)[] = [];
  const failNext = { value: false };
  for (const id of profileIds) store.set(id, { pending: EMPTY_PENDING, lastDigestAt: null });
  const deps: DigestDeps = {
    profiles: profileIds.map((id) => getProfile(id)),
    tz: TZ,
    load: async () => new Map(store),
    ids: async (_profile, keys) => new Map(keys.map((k) => [k, "j" + k.length.toString(16).padStart(7, "0")])),
    // A row's uuid is derived from its dedupe key so a test can name the button it expects.
    drafts: async (_profile, keys) => keys.map((k) => ({ key: k, id: UUID_OF(k), company: (k.split("::")[0] ?? k).replace(/^./, (c) => c.toUpperCase()) })),
    send: async (text, keyboard) => {
      if (failNext.value) {
        failNext.value = false;
        throw new Error("telegram down");
      }
      sent.push(text);
      keyboards.push(keyboard);
    },
    mark: async (profileId, when) => {
      store.set(profileId, { pending: EMPTY_PENDING, lastDigestAt: when });
    },
  };
  const buffer = (profileId: string, rows: ReturnType<typeof row>[], backfill = 0) => {
    const prev = store.get(profileId) ?? { pending: EMPTY_PENDING, lastDigestAt: null };
    store.set(profileId, { ...prev, pending: mergePending(prev.pending, rows, backfill) });
  };
  return { deps, store, sent, keyboards, buffer, failNext };
}

describe("a whole day of sweeps", () => {
  it("sends three group messages for 48 sweeps that each found a role for both candidates", async () => {
    const h = harness([DEFAULT_PROFILE_ID, WIFE_ID]);
    const start = at("2026-10-05T00:00:00Z").getTime();
    for (let i = 0; i < 48; i++) {
      const now = new Date(start + i * 30 * 60_000);
      h.buffer(DEFAULT_PROFILE_ID, [row("Alpha" + i)]);
      h.buffer(WIFE_ID, [row("Beta" + i)]);
      await sendDueDigest(now, h.deps);
    }
    expect(h.sent.length).toBe(3);
    expect(h.sent.length).toBeLessThanOrEqual(5);

    const delivered = h.sent
      .flatMap((text) => [...text.matchAll(/(\d+) new roles? for/g)])
      .reduce((sum, m) => sum + Number(m[1]), 0);
    const waiting = [...h.store.values()].reduce((sum, s) => sum + s.pending.rows.length + s.pending.overflow, 0);
    expect(delivered + waiting).toBe(96);
    expect(waiting).toBeGreaterThan(0);
  });

  it("sends nothing at all on a day when nothing was found", async () => {
    const h = harness([DEFAULT_PROFILE_ID, WIFE_ID]);
    const start = at("2026-10-05T00:00:00Z").getTime();
    for (let i = 0; i < 48; i++) await sendDueDigest(new Date(start + i * 30 * 60_000), h.deps);
    expect(h.sent).toEqual([]);
  });

  it("puts both candidates in ONE message, so two lanes do not double the count", async () => {
    const h = harness([DEFAULT_PROFILE_ID, WIFE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, [row("Alpha")]);
    h.buffer(WIFE_ID, [row("Beta")]);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("Alpha");
    expect(h.sent[0]).toContain("Beta");
  });
});

describe("delivery", () => {
  it("keeps the buffer when the send fails, and delivers it on the next sweep", async () => {
    const h = harness([WIFE_ID]);
    h.buffer(WIFE_ID, [row("Nexperia")]);
    h.failNext.value = true;
    await expect(sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps)).rejects.toThrow("telegram down");
    expect(h.store.get(WIFE_ID)?.pending.rows.length).toBe(1);
    expect(h.store.get(WIFE_ID)?.lastDigestAt).toBeNull();

    await sendDueDigest(at("2026-10-05T04:30:00Z"), h.deps);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("Nexperia");
    expect(h.store.get(WIFE_ID)?.pending.rows.length).toBe(0);
  });

  it("does not repeat itself inside a slot", async () => {
    const h = harness([WIFE_ID]);
    h.buffer(WIFE_ID, [row("Nexperia")]);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    h.buffer(WIFE_ID, [row("Bosch")]);
    await sendDueDigest(at("2026-10-05T04:30:00Z"), h.deps);
    expect(h.sent.length).toBe(1);
    await sendDueDigest(at("2026-10-05T09:00:00Z"), h.deps);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]).toContain("Bosch");
  });
});

describe("what the digest says", () => {
  it("keeps the sender-profile selector in every command it prints", async () => {
    const h = harness([WIFE_ID]);
    h.buffer(WIFE_ID, [row("Nexperia"), row("Bosch", "flag")], 4);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    const text = h.sent[0] ?? "";
    const commands = [...text.matchAll(/\/(?:draft|jobs|csv)\b[^<\n]*/g)].map((m) => m[0]);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const command of commands) expect(command).toContain("tashi");
  });

  it("prints no selector for the default candidate, as before", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, [row("Alpha")]);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    expect(h.sent[0]).toMatch(/<code>\/draft j[0-9a-f]{7}<\/code>/);
  });

  it("carries no sheet line, linked or not", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, [row("Alpha")]);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    expect(h.sent[0]?.toLowerCase()).not.toContain("sheet");
  });

  it("names more roles than a per-sweep alert did, and counts the rest", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, Array.from({ length: 12 }, (_, i) => row("Company" + i)));
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    expect(h.sent[0]).toContain("12 new roles");
    expect(h.sent[0]).toContain("Company4");
    expect(h.sent[0]).toMatch(/\+ \d+ more/);
  });

  it("reports a backfill-only buffer on its own line", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, [], 9);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    expect(h.sent[0]).toContain("9 older roles");
  });
});

describe("the Draft buttons under the batch", () => {
  const buttonsOf = (kb: DigestKeyboard | undefined) => (kb ?? []).flat();

  it("carries a 📝 Draft button for the first three passing roles, so the apply loop starts with a tap", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, ["Alpha", "Beta", "Gamma", "Delta"].map((c) => row(c)));
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    const buttons = buttonsOf(h.keyboards[0]);
    expect(buttons.map((b) => b.text)).toEqual(["📝 Draft — Alpha", "📝 Draft — Beta", "📝 Draft — Gamma"]);
    expect(buttons[0]?.callback_data).toBe(`jh:d:${UUID_OF("alpha::finance controller")}`);
  });

  it("skips flagged roles and sends no keyboard when no role passed", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, [row("Flagged", "flag")]);
    await sendDueDigest(at("2026-10-05T04:00:00Z"), h.deps);
    expect(h.sent.length).toBe(1);
    expect(buttonsOf(h.keyboards[0])).toEqual([]);
  });

  it("still sends the batch, without buttons, when the row lookup fails", async () => {
    const h = harness([DEFAULT_PROFILE_ID]);
    h.buffer(DEFAULT_PROFILE_ID, [row("Alpha")]);
    const failing: DigestDeps = {
      ...h.deps,
      drafts: async () => {
        throw new Error("db down");
      },
    };
    await sendDueDigest(at("2026-10-05T04:00:00Z"), failing);
    expect(h.sent.length).toBe(1);
    expect(buttonsOf(h.keyboards[0])).toEqual([]);
  });
});
