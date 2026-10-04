/**
 * P1-3 — /jobs and /today send ONE short message: the top 3 roles, a Draft button
 * each, then "Show more" and "CSV". The full brief is one tap away, not gone.
 */
import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import {
  COMPACT_MAX_CHARS,
  compactKeyboard,
  isPlainRequest,
  parseViewCallback,
  renderCompact,
  sendCompactBrief,
  type CompactRole,
} from "../../../src/gateway/jobhunt-compact.js";
import { getProfile, listProfiles } from "../../../src/tools/jobhunt/profile-config.js";
import { parseBriefRequest } from "../../../src/tools/jobhunt/brief-resolver.js";
import { handleBriefVerb, type JobsViewDeps } from "../../../src/gateway/jobhunt-view.js";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const role = (n: number, over: Partial<CompactRole> = {}): CompactRole => ({
  id: ID(n),
  company: `Company ${n}`,
  title: `Engineer ${n}`,
  url: `https://jobs.example.com/${n}`,
  ...over,
});

describe("renderCompact", () => {
  it("lists the roles, names the queue size, and stays under the limit", () => {
    const text = renderCompact([role(1), role(2), role(3)], 12, "your");
    expect(text).toContain("Company 1");
    expect(text).toContain("Company 3");
    expect(text).toContain("12");
    expect(text.length).toBeLessThanOrEqual(COMPACT_MAX_CHARS);
  });

  it("stays under the limit when every title is enormous", () => {
    const long = "X".repeat(900);
    const text = renderCompact([role(1, { title: long }), role(2, { title: long }), role(3, { title: long })], 40, "your");
    expect(text.length).toBeLessThanOrEqual(COMPACT_MAX_CHARS);
    expect(text).toContain("Company 3");
  });

  it("escapes HTML in company and title so the message cannot break parse_mode", () => {
    const text = renderCompact([role(1, { company: "A<b>&Co", title: "Dev <script>" })], 1, "your");
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("omits the link line for a row with no usable url instead of printing 'null'", () => {
    const text = renderCompact([role(1, { url: null })], 1, "your");
    expect(text).not.toMatch(/null|undefined/);
  });
});

describe("compactKeyboard + parseViewCallback", () => {
  it("has a Draft button per role, then Show more and CSV on the last row", () => {
    const rows = compactKeyboard([role(1), role(2)], "today", "pushkar-nl-tech").inline_keyboard;
    expect(rows).toHaveLength(3);
    expect(rows[2]!.map((b) => b.text)).toEqual(["➕ Show more", "📎 CSV"]);
  });

  it("keeps every callback_data inside Telegram's 64-byte cap", () => {
    for (const row of compactKeyboard([role(1), role(2), role(3)], "today", "pushkar-nl-tech").inline_keyboard)
      for (const b of row) expect(Buffer.byteLength((b as { callback_data: string }).callback_data)).toBeLessThanOrEqual(64);
  });

  it("every registered profile's real id fits in the 64-byte callback_data", () => {
    for (const p of listProfiles())
      for (const row of compactKeyboard([role(1)], "today", p.id).inline_keyboard)
        for (const b of row) expect(Buffer.byteLength((b as { callback_data: string }).callback_data)).toBeLessThanOrEqual(64);
  });

  it("round-trips more/csv payloads and rejects anything else", () => {
    const rows = compactKeyboard([role(1)], "jobs", "wife").inline_keyboard;
    const [more, csv] = rows[1]!.map((b) => (b as { callback_data: string }).callback_data);
    expect(parseViewCallback(more!)).toEqual({ kind: "more", verb: "jobs", profileId: "wife" });
    expect(parseViewCallback(csv!)).toEqual({ kind: "csv", profileId: "wife" });
    expect(parseViewCallback("jh:m:fresh:wife")).toBeNull();
    expect(parseViewCallback("jh:d:" + ID(1))).toBeNull();
    expect(parseViewCallback("nope")).toBeNull();
  });
});

describe("isPlainRequest", () => {
  it("is true for a bare command or just a profile name, false once a range or axis is given", () => {
    expect(isPlainRequest("", "jobs")).toBe(true);
    expect(isPlainRequest("wife", "jobs")).toBe(true);
    expect(isPlainRequest("7d", "jobs")).toBe(false);
    expect(isPlainRequest("wife 7d", "jobs")).toBe(false);
  });
});

describe("sendCompactBrief", () => {
  const profile = { id: "pushkar-nl-tech", candidateName: "Pushkar", tenantId: "t" } as never;
  const ctx = () => {
    const reply = vi.fn(async (..._a: unknown[]) => undefined);
    return { ctx: { reply } as unknown as Context, reply };
  };

  it("sends exactly one message with the keyboard and returns true", async () => {
    const { ctx: c, reply } = ctx();
    const sent = await sendCompactBrief(c, profile, "jobs", false, async () => ({ roles: [role(1), role(2)], total: 9 }));
    expect(sent).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![1]).toMatchObject({ parse_mode: "HTML" });
  });

  it("returns false (so the full brief explains) when no role is ready", async () => {
    const { ctx: c, reply } = ctx();
    expect(await sendCompactBrief(c, profile, "jobs", false, async () => ({ roles: [], total: 0 }))).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  it("returns false when the lookup throws, so the founder still gets the full brief", async () => {
    const { ctx: c } = ctx();
    expect(await sendCompactBrief(c, profile, "jobs", false, async () => { throw new Error("db"); })).toBe(false);
  });
});

describe("handleBriefVerb — compact wiring", () => {
  const deps = (over: Partial<JobsViewDeps> = {}): JobsViewDeps => ({
    buildBrief: async () => "FULL BRIEF",
    split: (t) => [t],
    lastFreshView: async () => null,
    recordFreshView: async () => {},
    topRoles: async () => ({ roles: [role(1), role(2), role(3)], total: 7 }),
    ...over,
  });
  const run = async (verb: "jobs" | "today" | "fresh", match: string, d: JobsViewDeps) => {
    const replies: string[] = [];
    const ctx = { match, reply: vi.fn(async (t: string) => void replies.push(t)) } as unknown as Context;
    await handleBriefVerb(ctx, verb, d);
    return replies;
  };

  it("/jobs sends the running line plus ONE compact message, not the full brief", async () => {
    const replies = await run("jobs", "", deps());
    expect(replies).toHaveLength(2);
    expect(replies.join("\n")).not.toContain("FULL BRIEF");
    expect(replies[1]).toContain("Company 1");
  });

  it("/jobs 7d keeps the full brief — an explicit range asks for the long view", async () => {
    expect((await run("jobs", "7d", deps())).join("\n")).toContain("FULL BRIEF");
  });

  it("/fresh keeps the full brief", async () => {
    expect((await run("fresh", "", deps())).join("\n")).toContain("FULL BRIEF");
  });

  it("falls back to the full brief when nothing is ready to apply to", async () => {
    expect((await run("jobs", "", deps({ topRoles: async () => ({ roles: [], total: 0 }) }))).join("\n")).toContain("FULL BRIEF");
  });

  it("without a topRoles dep the old behaviour is unchanged", async () => {
    const { topRoles: _omit, ...rest } = deps();
    expect((await run("jobs", "", rest as JobsViewDeps)).join("\n")).toContain("FULL BRIEF");
  });
});

describe("parseBriefRequest sanity for the plain check", () => {
  it("defaults come from the resolver, not a copy", () => {
    expect(parseBriefRequest("", "jobs")).toMatchObject({ verb: "jobs" });
  });
});

describe("handleJobCallback — Show more and CSV taps", () => {
  const mk = (data: string) => {
    const calls = { answer: [] as string[], replies: [] as string[], docs: 0 };
    const ctx = {
      callbackQuery: { data },
      answerCallbackQuery: vi.fn(async (a?: { text?: string }) => void calls.answer.push(a?.text ?? "")),
      reply: vi.fn(async (t: string) => void calls.replies.push(t)),
      replyWithDocument: vi.fn(async () => void calls.docs++),
    } as unknown as Context;
    return { ctx, calls };
  };
  const jobs = (): JobsViewDeps => ({
    buildBrief: vi.fn(async () => "FULL BRIEF"),
    split: (t) => [t],
    lastFreshView: async () => null,
    recordFreshView: async () => {},
  });

  it("Show more rebuilds and sends the full brief for the tapped verb and profile", async () => {
    const { handleJobCallback } = await import("../../../src/gateway/jobhunt-callbacks.js");
    const wife = listProfiles().find((p) => p.id !== getProfile().id) ?? getProfile();
    const { ctx, calls } = mk(`jh:m:today:${wife.id}`);
    const d = jobs();
    expect(await handleJobCallback(ctx, { runKernelText: vi.fn() } as never, d)).toBe(true);
    expect(calls.replies.join("\n")).toContain("FULL BRIEF");
    expect((d.buildBrief as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ id: wife.id });
  });

  it("an unknown profile id on a tap is answered, not thrown", async () => {
    const { handleJobCallback } = await import("../../../src/gateway/jobhunt-callbacks.js");
    const { ctx, calls } = mk("jh:m:jobs:nobody");
    expect(await handleJobCallback(ctx, { runKernelText: vi.fn() } as never, jobs())).toBe(true);
    expect(calls.answer.join(" ")).toMatch(/out of date/i);
  });
});
