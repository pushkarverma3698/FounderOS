import { describe, expect, it, vi } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";
import { runShadowApply, shadowApplyEnabled, shadowPerRunCap, type ShadowDeps, type ShadowRow } from "../../../src/tools/jobhunt/shadow-apply.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const NOW = new Date("2026-11-15T12:00:00Z");
const PASS = JSON.stringify([{ gate: "Sponsor", status: "pass", evidence: "x" }]);
const mk = (id: string, url: string): ShadowRow => ({
  id, company: `Co ${id}`, title: "Engineer", url, track: "", gate_json: PASS,
  created_at: new Date(NOW.getTime() - 3_600_000), applied_at: null, skipped_at: null, liveness: "unknown", apply_lane_at: null,
});
const profile = (id: string): JobSearchProfile => ({ id, candidateName: id }) as JobSearchProfile;
const applyProfile = { first_name: "A", last_name: "B", email: "a@b.c", phone: "1" } as ApplyProfile;
const okSummary = { filled: 3, total: 3, filledLabels: [], filledAnswers: [], unanswered: [], requiredUnanswered: [], hasCaptcha: false, readyToSubmit: true };

function deps(rows: Record<string, ShadowRow[]>, over: Partial<ShadowDeps> = {}) {
  const prepare = vi.fn(async (url: string) => ({ ok: true as const, platform: "lever" as const, targetUrl: url, summary: okSummary, screenshotPng: Buffer.alloc(0) }));
  const record = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const d: ShadowDeps = {
    now: () => NOW,
    profiles: () => Object.keys(rows).map(profile),
    loadProfile: async () => applyProfile,
    loadDossier: async () => undefined,
    resumeFor: async () => undefined,
    candidates: async (id) => rows[id] ?? [],
    claim: async () => true,
    record,
    prepare,
    send,
    ...over,
  };
  return { d, prepare, record, send };
}

describe("env switches", () => {
  it("is off unless exactly on", () => {
    expect(shadowApplyEnabled({})).toBe(false);
    expect(shadowApplyEnabled({ AUTO_APPLY_SHADOW: "off" })).toBe(false);
    expect(shadowApplyEnabled({ AUTO_APPLY_SHADOW: "ON" })).toBe(true);
  });
  it("cap defaults to 5 and rejects junk", () => {
    expect(shadowPerRunCap({})).toBe(5);
    expect(shadowPerRunCap({ AUTO_APPLY_PREPARE_PER_RUN: "2" })).toBe(2);
    expect(shadowPerRunCap({ AUTO_APPLY_PREPARE_PER_RUN: "0" })).toBe(5);
    expect(shadowPerRunCap({ AUTO_APPLY_PREPARE_PER_RUN: "x" })).toBe(5);
  });
});

describe("runShadowApply", () => {
  it("caps browser opens across profiles, newest first, and leaves the rest for the next run", async () => {
    const rows = { p1: [1, 2, 3].map((n) => mk(`a${n}`, "https://jobs.lever.co/x/1")), p2: [mk("b1", "https://jobs.lever.co/y/2")] };
    const { d, prepare, record, send } = deps(rows);
    const out = await runShadowApply(d, { AUTO_APPLY_PREPARE_PER_RUN: "2" });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(out.routed.map((r) => r.company)).toEqual(["Co a1", "Co a2"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes Workday without opening a browser and without using the cap", async () => {
    const { d, prepare, record } = deps({ p1: [mk("w", "https://acme.myworkdayjobs.com/en/job/1"), mk("l", "https://jobs.lever.co/x/1")] });
    const out = await runShadowApply(d, { AUTO_APPLY_PREPARE_PER_RUN: "1" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(out.routed.map((r) => r.lane)).toEqual(["hand_off", "auto"]);
    expect(out.routed[0]?.reason).toMatch(/Workday/);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("skips rows another run already claimed, and rows the selection rule rejects", async () => {
    const stale = { ...mk("old", "https://jobs.lever.co/x/1"), applied_at: NOW };
    const { d, prepare } = deps({ p1: [mk("a", "https://jobs.lever.co/x/1"), stale] }, { claim: async () => false });
    const out = await runShadowApply(d, {});
    expect(prepare).not.toHaveBeenCalled();
    expect(out.routed).toEqual([]);
  });

  it("records a crashed form run as a hand-off and carries on; sends nothing when nothing routed", async () => {
    const boom = vi.fn(async () => { throw new Error("browser died"); });
    const { d, record } = deps({ p1: [mk("a", "https://jobs.lever.co/x/1")] }, { prepare: boom });
    const out = await runShadowApply(d, {});
    expect(out.routed[0]?.lane).toBe("hand_off");
    expect(record).toHaveBeenCalledTimes(1);
    const none = deps({ p1: [] });
    await runShadowApply(none.d, {});
    expect(none.send).not.toHaveBeenCalled();
  });

  it("a failed Telegram send does not throw", async () => {
    const { d } = deps({ p1: [mk("a", "https://jobs.lever.co/x/1")] }, { send: async () => { throw new Error("tg down"); } });
    await expect(runShadowApply(d, {})).resolves.toBeDefined();
  });

  it("skips a profile with no usable apply profile", async () => {
    const { d, prepare } = deps({ p1: [mk("a", "https://jobs.lever.co/x/1")] }, { loadProfile: async () => null });
    await runShadowApply(d, {});
    expect(prepare).not.toHaveBeenCalled();
  });
});
