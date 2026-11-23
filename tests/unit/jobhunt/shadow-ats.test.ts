import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAtsRecord } from "../../../src/tools/jobhunt/ats-record.js";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";
import { runShadowApply, type ShadowDeps, type ShadowRow } from "../../../src/tools/jobhunt/shadow-apply.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/tools/jobhunt/resume-pdf.js", () => ({ resolveResumePdf: vi.fn(), artifactDirForChat: (id: string) => `/art/${id}` }));
vi.mock("../../../src/infra/telegram-send.js", () => ({ jobsChatId: () => "jobs-chat" }));

const NOW = new Date("2026-11-15T12:00:00Z");
const PASS = JSON.stringify([{ gate: "Sponsor", status: "pass", evidence: "x" }]);
const mk = (id: string): ShadowRow => ({
  id, company: `Co ${id}`, title: "Engineer", url: "https://jobs.lever.co/x/1", track: "", gate_json: PASS,
  created_at: new Date(NOW.getTime() - 3_600_000), applied_at: null, skipped_at: null, liveness: "unknown", apply_lane_at: null,
});
const profile = (id: string): JobSearchProfile => ({ id, candidateName: id }) as JobSearchProfile;
const applyProfile = { first_name: "A", last_name: "B", email: "a@b.c", phone: "1" } as ApplyProfile;
const summary = (over: Record<string, unknown> = {}) => ({ filled: 3, total: 3, filledLabels: [], filledAnswers: [], unanswered: [], requiredUnanswered: [], hasCaptcha: false, readyToSubmit: true, ...over });
const ATS = buildAtsRecord({ ratio: 0.25, matched: ["ts"], missing: ["go", "rust"], tailored: true });

function setup(rows: ShadowRow[], sum = summary(), tailorRow: ShadowDeps["tailorRow"] = vi.fn(async () => ATS)) {
  const record = vi.fn(async () => undefined);
  const send = vi.fn(async (_m: string) => undefined);
  const d: ShadowDeps = {
    now: () => NOW,
    profiles: () => [profile("p1")],
    loadProfile: async () => applyProfile,
    loadDossier: async () => undefined,
    resumeFor: async () => undefined,
    candidates: async () => rows,
    claim: async () => true,
    record,
    prepare: vi.fn(async (url: string) => ({ ok: true as const, platform: "lever" as const, targetUrl: url, summary: sum, screenshotPng: Buffer.alloc(0) })) as never,
    tailorRow,
    send,
  };
  return { d, record, send };
}

afterEach(() => {
  delete process.env["APPLY_ATS_MIN_OVERLAP"];
});

describe("shadow pass tailoring and ATS gate", () => {
  it("tailors an auto row and, with the minimum at 0, records only", async () => {
    const tailorRow = vi.fn(async () => ATS);
    const { d, record, send } = setup([mk("a")], summary(), tailorRow);
    const out = await runShadowApply(d, {});
    expect(tailorRow).toHaveBeenCalledTimes(1);
    expect(out.routed[0]).toMatchObject({ lane: "auto", ats: ATS });
    expect(record).toHaveBeenCalledWith("a", expect.objectContaining({ lane: "auto" }), NOW);
    expect(send.mock.calls[0]![0]).toContain("ATS 25%, tailored yes");
  });

  it("moves a below-minimum auto row to hand_off with the ATS reason", async () => {
    process.env["APPLY_ATS_MIN_OVERLAP"] = "40";
    const { d, record } = setup([mk("a")]);
    const out = await runShadowApply(d, {});
    expect(out.routed[0]).toMatchObject({ lane: "hand_off", reason: "ATS fit 25% below 40%; missing: go, rust" });
    expect(record).toHaveBeenCalledWith("a", { lane: "hand_off", reason: "ATS fit 25% below 40%; missing: go, rust" }, NOW);
  });

  it("tailors a Mac-solvable hand-off (captcha) but not a needs_you row", async () => {
    const tailorRow = vi.fn(async () => ATS);
    const cap = setup([mk("c")], summary({ hasCaptcha: true, captchaVendor: "hCaptcha" }), tailorRow);
    await runShadowApply(cap.d, {});
    expect(tailorRow).toHaveBeenCalledTimes(1);

    const needs = vi.fn(async () => ATS);
    const n = setup([mk("n")], summary({ requiredUnanswered: [{ label: "Why us?" }] }), needs);
    await runShadowApply(n.d, {});
    expect(needs).not.toHaveBeenCalled();
  });

  it("a null ATS result (budget spent or failure) leaves the lane untouched", async () => {
    process.env["APPLY_ATS_MIN_OVERLAP"] = "90";
    const { d } = setup([mk("a")], summary(), vi.fn(async () => null));
    const out = await runShadowApply(d, {});
    expect(out.routed[0]?.lane).toBe("auto");
    expect(out.routed[0]?.ats).toBeUndefined();
  });

  it("shares one per-run budget across rows", async () => {
    const seen: number[] = [];
    const tailorRow: ShadowDeps["tailorRow"] = async (_r, _p, budget) => {
      seen.push(budget.left);
      budget.left -= 1;
      return ATS;
    };
    const { d } = setup([mk("a"), mk("b")], summary(), tailorRow);
    await runShadowApply(d, { APPLY_TAILOR_PER_RUN: "7" });
    expect(seen).toEqual([7, 6]);
  });
});
