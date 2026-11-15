import { describe, expect, it, vi } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";
import type { FormPlanSummary } from "../../../src/tools/jobhunt/form-filled.js";
import { runShadowApply, type ShadowDeps, type ShadowRow } from "../../../src/tools/jobhunt/shadow-apply.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const NOW = new Date("2026-11-15T12:00:00Z");
const PASS = JSON.stringify([{ gate: "Sponsor", status: "pass", evidence: "x" }]);
const mk = (id: string, company = `Co ${id}`): ShadowRow => ({
  id, company, title: "Engineer", url: "https://jobs.lever.co/x/1", track: "", gate_json: PASS,
  created_at: new Date(NOW.getTime() - 3_600_000), applied_at: null, skipped_at: null, liveness: "unknown", apply_lane_at: null,
});
const clean: FormPlanSummary = {
  filled: 1, total: 1, filledLabels: ["Email"], unanswered: [], requiredUnanswered: [], hasCaptcha: false, readyToSubmit: true,
  filledAnswers: [{ label: "Email", value: "v", fieldType: "text", editable: true, source: "profile", confidence: 1 }],
};
const letterForm: FormPlanSummary = {
  ...clean,
  requiredUnanswered: [{ selector: "#c", label: "Cover letter", kind: "ask", question: "Cover letter", required: true, fieldType: "textarea", why: "w" }],
  unanswered: [{ selector: "#c", label: "Cover letter", kind: "ask", question: "Cover letter", required: true, fieldType: "textarea", why: "w" }],
};

function setup(rows: ShadowRow[], summary: FormPlanSummary, over: Partial<NonNullable<ShadowDeps["autoSend"]>> = {}) {
  const send = vi.fn(async () => ({ kind: "sent" as const, detail: "confirmed" }));
  const runtimeOn = vi.fn(async () => true);
  const history = vi.fn(async () => ({ sentToday: 0, recent: [] }));
  const record = vi.fn(async () => undefined);
  const prepare = vi.fn(async (url: string) => ({ ok: true as const, platform: "lever" as const, targetUrl: url, summary, screenshotPng: Buffer.alloc(0) }));
  const d: ShadowDeps = {
    now: () => NOW,
    profiles: () => [{ id: "p1", candidateName: "p1" } as JobSearchProfile],
    loadProfile: async () => ({ first_name: "A", last_name: "B", email: "a@b.c", phone: "1" }) as ApplyProfile,
    loadDossier: async () => undefined,
    resumeFor: async () => undefined,
    candidates: async () => rows,
    claim: async () => true,
    record,
    prepare,
    send: vi.fn(async () => undefined),
    autoSend: { runtimeOn, history, send, ...over },
  };
  return { d, send, runtimeOn, history, record };
}

describe("shadow pass auto-send hand-off", () => {
  it("sends nothing when the env switch is off, and does not even read the runtime switch", async () => {
    const t = setup([mk("a")], clean);
    await runShadowApply(t.d, {});
    expect(t.send).not.toHaveBeenCalled();
    expect(t.runtimeOn).not.toHaveBeenCalled();
  });
  it("sends nothing when the env is on but the runtime switch is off", async () => {
    const t = setup([mk("a")], clean, { runtimeOn: vi.fn(async () => false) });
    const out = await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    expect(t.send).not.toHaveBeenCalled();
    expect(out.routed[0]?.reason).toContain("not auto-sent");
  });
  it("sends exactly once when both switches are on and the rules pass", async () => {
    const t = setup([mk("a")], clean);
    const out = await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(out.routed[0]?.reason).toContain("auto-sent: confirmed");
  });
  it("sends nothing for a needs_you or hand_off row", async () => {
    const ask = { ...clean, requiredUnanswered: [{ selector: "#q", label: "Why us?", kind: "ask" as const, question: "q", required: true, fieldType: "text" as const, why: "w" }] };
    const t = setup([mk("a")], ask);
    await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    const t2 = setup([mk("b")], { ...clean, hasCaptcha: true });
    await runShadowApply(t2.d, { AUTO_APPLY_SEND: "on" });
    expect(t.send).not.toHaveBeenCalled();
    expect(t2.send).not.toHaveBeenCalled();
  });
  it("sends nothing when an answer has no trusted source", async () => {
    const t = setup([mk("a")], { ...clean, filledAnswers: [{ label: "Why us?", value: "v", fieldType: "text", editable: true, source: "unknown", confidence: 1 }] });
    await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    expect(t.send).not.toHaveBeenCalled();
  });
  it("stops at the daily cap, re-reading history after each send", async () => {
    let sent = 0;
    const t = setup([mk("a"), mk("b"), mk("c")], clean, {
      history: vi.fn(async () => ({ sentToday: sent, recent: [] })),
      send: vi.fn(async () => { sent += 1; return { kind: "sent" as const, detail: "confirmed" }; }),
    });
    await runShadowApply(t.d, { AUTO_APPLY_SEND: "on", AUTO_APPLY_DAILY_CAP: "2" });
    expect(sent).toBe(2);
  });
  it("sends one application per company within the pass", async () => {
    const recent: { company: string; at: Date }[] = [];
    const t = setup([mk("a", "Acme"), mk("b", "ACME Ltd"), mk("c", "Globex")], clean, {
      history: vi.fn(async () => ({ sentToday: recent.length, recent })),
      send: vi.fn(async (row) => { recent.push({ company: row.company, at: NOW }); return { kind: "sent" as const, detail: "confirmed" }; }),
    });
    await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    expect(recent.map((r) => r.company)).toEqual(["Acme", "Globex"]);
  });
  it("routes the row to needs_you when no clean cover letter exists", async () => {
    const t = setup([mk("a")], letterForm, { send: vi.fn(async () => ({ kind: "no-letter" as const, detail: "no letter" })) });
    const out = await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    expect(out.routed[0]).toMatchObject({ lane: "needs_you", reason: "no letter" });
    expect(t.record).toHaveBeenLastCalledWith("a", { lane: "needs_you", reason: "no letter" }, NOW);
  });
  it("a failing history lookup sends nothing and does not fail the pass", async () => {
    const t = setup([mk("a")], clean, { history: vi.fn(async () => { throw new Error("db down"); }) });
    const out = await runShadowApply(t.d, { AUTO_APPLY_SEND: "on" });
    expect(t.send).not.toHaveBeenCalled();
    expect(out.routed).toHaveLength(1);
  });
});
