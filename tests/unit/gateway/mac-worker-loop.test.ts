/**
 * Mac worker loop: lease -> fill -> challenge / submit / report, with a fake API and a fake page.
 * The send rule: submit only when canAutoSend passes AND no visible challenge shows; dry run never clicks.
 */

import { describe, expect, it } from "vitest";
import {
  CHALLENGE_WAIT_MS, processLease, sendGate, type FormSession, type LoopDeps, type MacApi, type ResultInput, type SubmitResult,
} from "../../../src/gateway/mac-worker-loop.js";
import type { MacPacket } from "../../../src/gateway/mac-worker-packet.js";
import type { FormPlanSummary } from "../../../src/tools/jobhunt/form-filled.js";

const ROW = "11111111-2222-4333-8444-555555555555";
const LEASE = { leaseId: "lease-0001", rowId: ROW };
const PACKET: MacPacket = {
  rowId: ROW, company: "Acme", title: "Dev", url: "https://jobs.lever.co/acme/1", answers: [], plan: null,
  cv: { filename: "cv.pdf", bytes: 3 }, auditKey: "k",
};
const answer = (label: string, source: "profile" | "unknown" = "profile") =>
  ({ label, value: "x", fieldType: "text" as const, editable: false, source, confidence: 1 });
const summary = (over: Partial<FormPlanSummary> = {}): FormPlanSummary => ({
  filled: 1, total: 1, filledLabels: ["Name"], filledAnswers: [answer("Name")], unanswered: [], requiredUnanswered: [],
  hasCaptcha: false, readyToSubmit: true, ...over,
});

interface Script {
  fill?: { ok: true; summary: FormPlanSummary } | { ok: false; reason: string };
  challenge?: boolean[]; // successive answers; the last repeats
  refusal?: string | null;
  submit?: SubmitResult;
  afterChallenge?: SubmitResult;
}

function harness(script: Script, opts: { live?: boolean } = {}) {
  const results: ResultInput[] = [];
  const calls: string[] = [];
  let clock = 0;
  const probes = [...(script.challenge ?? [false])];
  const session: FormSession = {
    fill: async () => (calls.push("fill"), script.fill ?? { ok: true, summary: summary() }),
    challengeVisible: async () => (calls.push("challenge?"), probes.length > 1 ? probes.shift()! : probes[0]!),
    preSubmitRefusal: async () => script.refusal ?? null,
    submit: async () => (calls.push("submit"), script.submit ?? { kind: "confirmed", evidence: "thanks" }),
    afterChallenge: async () => (calls.push("afterChallenge"), script.afterChallenge ?? { kind: "confirmed", evidence: "thanks" }),
    proof: async () => Buffer.from("png"),
    close: async () => void calls.push("close"),
  };
  const api: MacApi = {
    heartbeat: async () => void calls.push("beat"),
    lease: async () => LEASE,
    packet: async () => PACKET,
    cv: async () => Buffer.from("pdf"),
    result: async (r) => void results.push(r),
  };
  const deps: LoopDeps = {
    api, live: opts.live ?? true, dailyCap: 10, now: () => new Date(clock), sleep: async (ms) => void (clock += ms),
    writeCv: async () => "/tmp/cv.pdf", openSession: async () => session, log: () => undefined,
    sentToday: 0, stop: () => false,
  };
  return { deps, results, calls };
}

describe("sendGate", () => {
  const limits = { dailyCap: 10, sentToday: 0, now: new Date(0) };
  it("passes a clean, trusted form", () => {
    expect(sendGate(PACKET, summary(), false, limits).ok).toBe(true);
  });
  it("refuses while a challenge is visible", () => {
    expect(sendGate(PACKET, summary(), true, limits).ok).toBe(false);
  });
  it("refuses an answer that is not from the profile, dossier or approved answers", () => {
    expect(sendGate(PACKET, summary({ filledAnswers: [answer("Why us?", "unknown")] }), false, limits)).toMatchObject({ ok: false });
  });
  it("refuses when a required question is open and when the daily cap is hit", () => {
    expect(sendGate(PACKET, summary({ requiredUnanswered: [{ label: "Visa?" } as never] }), false, limits).ok).toBe(false);
    expect(sendGate(PACKET, summary(), false, { ...limits, sentToday: 10 }).ok).toBe(false);
  });
});

describe("processLease", () => {
  it("live, no challenge: submits once and reports confirmed with the proof screenshot", async () => {
    const h = harness({});
    await processLease(h.deps, LEASE);
    expect(h.calls).toContain("submit");
    expect(h.results).toEqual([{ rowId: ROW, leaseId: "lease-0001", outcome: "confirmed", detail: "thanks", proofScreenshot: Buffer.from("png").toString("base64") }]);
    expect(h.calls.at(-1)).toBe("close");
  });

  it("dry run (the default): fills, never clicks Submit, reports dry_run (no attempt spent)", async () => {
    const h = harness({}, { live: false });
    await processLease(h.deps, LEASE);
    expect(h.calls).not.toContain("submit");
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ outcome: "dry_run" });
    expect(h.results[0]!.detail).toMatch(/Submit not clicked/i);
  });

  it("visible challenge: reports challenge, waits until it clears, then submits and confirms", async () => {
    const h = harness({ challenge: [true, true, false] });
    await processLease(h.deps, LEASE);
    expect(h.results.map((r) => r.outcome)).toEqual(["challenge", "confirmed"]);
    expect(h.calls).toContain("submit");
  });

  it("a challenge that never clears is given up on after 30 minutes without submitting", async () => {
    const h = harness({ challenge: [true] });
    await processLease(h.deps, LEASE);
    expect(h.calls).not.toContain("submit");
    expect(h.results.map((r) => r.outcome)).toEqual(["challenge", "failed"]);
    expect(h.results[1]!.detail).toMatch(/30 min/);
    expect(CHALLENGE_WAIT_MS).toBe(30 * 60_000);
  });

  it("a form the gate refuses (unanswered required question) never pings for a challenge and never submits", async () => {
    const h = harness({ challenge: [true], fill: { ok: true, summary: summary({ requiredUnanswered: [{ label: "Visa?" } as never] }) } });
    await processLease(h.deps, LEASE);
    expect(h.calls).not.toContain("submit");
    expect(h.results.map((r) => r.outcome)).toEqual(["failed"]);
    expect(h.results[0]!.detail).toMatch(/Visa|unanswered/);
  });

  it("a fill failure or a pre-submit refusal reports failed and does not submit", async () => {
    const a = harness({ fill: { ok: false, reason: "no fields" } });
    await processLease(a.deps, LEASE);
    expect(a.results[0]).toMatchObject({ outcome: "failed", detail: "no fields" });
    const b = harness({ refusal: "native validation failed on Phone" });
    await processLease(b.deps, LEASE);
    expect(b.calls).not.toContain("submit");
    expect(b.results[0]!.detail).toMatch(/Phone/);
  });

  it("the email code step reports code_needed and leaves the tab open", async () => {
    const h = harness({ submit: { kind: "code-needed", evidence: "code asked" } });
    await processLease(h.deps, LEASE);
    expect(h.results.map((r) => r.outcome)).toEqual(["code_needed"]);
    expect(h.calls).not.toContain("close");
  });

  it("a challenge that appears after the click is reported, waited out, and the outcome re-read", async () => {
    const h = harness({ challenge: [false, false, false], submit: { kind: "challenge", evidence: "hcaptcha popped up" } });
    await processLease(h.deps, LEASE);
    expect(h.results.map((r) => r.outcome)).toEqual(["challenge", "confirmed"]);
    expect(h.calls).toContain("afterChallenge");
  });

  it("clicked but unconfirmed: reported as `unconfirmed` (never `failed`, which would allow a re-lease), tab left open", async () => {
    const h = harness({ submit: { kind: "unconfirmed", evidence: "no banner" } });
    await processLease(h.deps, LEASE);
    expect(h.results[0]).toMatchObject({ outcome: "unconfirmed" });
    expect(h.results[0]!.detail).toMatch(/Submit was clicked/);
    expect(h.calls).not.toContain("close");
  });

  it("a crash anywhere reports failed instead of throwing", async () => {
    const h = harness({});
    const deps = { ...h.deps, openSession: async (): Promise<FormSession> => { throw new Error("cdp down"); } };
    await expect(processLease(deps, LEASE)).resolves.toBeUndefined();
    expect(h.results[0]).toMatchObject({ outcome: "failed" });
    expect(h.results[0]!.detail).toMatch(/cdp down/);
  });
});
