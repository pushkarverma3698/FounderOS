/**
 * Mac worker loop: the decisions
 * ==============================
 * lease -> packet + CV -> fill -> (challenge | gate) -> submit -> report. No Playwright and no fetch in here: the
 * VPS API and the open tab come in as `MacApi` and `FormSession`, so every branch is unit-tested with fakes
 * (tests/unit/gateway/mac-worker-loop.test.ts).
 *
 * Send rule: Submit is clicked only when `canAutoSend` passes AND no challenge is visible, and only with `live`.
 * A visible challenge is reported (the VPS pings the founder), the tab stays open and is polled for up to 30 min.
 * Dry run (the default) fills and runs every check, then reports `dry_run` (the server frees the lease without spending an attempt) and never clicks.
 */

import { canAutoSend, type AutoSendDecision } from "../tools/jobhunt/auto-send-rules.js";
import type { FormPlanSummary } from "../tools/jobhunt/form-filled.js";
import type { MacPacket } from "./mac-worker-packet.js";

export const CHALLENGE_WAIT_MS = 30 * 60_000;
export const CHALLENGE_POLL_MS = 5_000;
export const HEARTBEAT_MS = 5 * 60_000;
export const IDLE_POLL_MS = 60_000;

export interface ResultInput {
  readonly rowId: string;
  readonly leaseId: string;
  readonly outcome: "confirmed" | "challenge" | "code_needed" | "failed" | "unconfirmed" | "dry_run";
  readonly detail: string;
  readonly proofScreenshot?: string;
}

export interface MacLease {
  readonly leaseId: string;
  readonly rowId: string;
  /** Known once the packet is in; only used for the local log line, never sent. */
  readonly company?: string;
}

const LOG_DETAIL_CHARS = 200;

export interface MacApi {
  heartbeat(): Promise<void>;
  lease(): Promise<MacLease | null>;
  packet(lease: MacLease): Promise<MacPacket>;
  cv(lease: MacLease): Promise<Buffer>;
  result(body: ResultInput): Promise<void>;
}

export type FillOutcome = { readonly ok: true; readonly summary: FormPlanSummary } | { readonly ok: false; readonly reason: string };
export interface SubmitResult {
  readonly kind: "confirmed" | "code-needed" | "unconfirmed" | "challenge";
  readonly evidence: string;
}

/** One open tab on one form. The Playwright version is mac-worker-browser.ts. */
export interface FormSession {
  fill(): Promise<FillOutcome>;
  /** A bot-check widget a person must act on is on screen right now. */
  challengeVisible(): Promise<boolean>;
  /** Native validity, empty required fields, no Submit control: the reason Submit must not be clicked, or null. */
  preSubmitRefusal(): Promise<string | null>;
  submit(): Promise<SubmitResult>;
  /** Re-read the page after the person cleared a post-click challenge. */
  afterChallenge(): Promise<SubmitResult>;
  proof(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface LoopDeps {
  readonly api: MacApi;
  /** False (the default in the entry) fills but never clicks Submit. */
  readonly live: boolean;
  readonly dailyCap: number;
  /** Submit clicks made by this process today; the loop bumps it. */
  sentToday: number;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly writeCv: (packet: MacPacket, bytes: Buffer) => Promise<string>;
  readonly openSession: (packet: MacPacket, cvPath: string) => Promise<FormSession>;
  readonly log: (msg: string) => void;
  readonly stop: () => boolean;
}

/** `canAutoSend` with the bot-check clause driven by what is on screen right now, not by the VPS scrape. */
export function sendGate(
  packet: Pick<MacPacket, "company">,
  summary: FormPlanSummary,
  challengeVisible: boolean,
  limits: { readonly dailyCap: number; readonly sentToday: number; readonly now: Date },
): AutoSendDecision {
  return canAutoSend(
    { company: packet.company },
    { lane: "auto", reason: "mac worker", summary: { ...summary, hasCaptcha: challengeVisible } },
    { envOn: true, runtimeOn: true, dailyCap: limits.dailyCap, now: limits.now },
    // The per-company cooldown is the VPS's to know; the Mac only counts its own sends against the daily cap.
    { sentToday: limits.sentToday, recent: [] },
  );
}

class Beater {
  private last: number;
  constructor(private readonly deps: LoopDeps) {
    this.last = deps.now().getTime();
  }
  async tick(): Promise<void> {
    if (this.deps.now().getTime() - this.last < HEARTBEAT_MS) return;
    this.last = this.deps.now().getTime();
    // allow-failopen: a missed heartbeat only makes the VPS think the Mac is offline for a while.
    await this.deps.api.heartbeat().catch(() => undefined);
  }
}

/** Poll until the challenge is gone (true) or 30 minutes pass (false). Keeps the heartbeat going meanwhile. */
async function waitForClear(deps: LoopDeps, session: FormSession): Promise<boolean> {
  const beat = new Beater(deps);
  const deadline = deps.now().getTime() + CHALLENGE_WAIT_MS;
  while (deps.now().getTime() < deadline && !deps.stop()) {
    await deps.sleep(CHALLENGE_POLL_MS);
    // allow-failopen: a failed probe (page navigating) counts as still showing; the 30-minute deadline ends the wait.
    if (!(await session.challengeVisible().catch(() => true))) return true;
    await beat.tick();
  }
  return false;
}

/** The one local line per outcome that the launchd log shows: row, company, outcome, a clipped detail. No proof, no answers. */
const outcomeLine = (lease: MacLease, outcome: ResultInput["outcome"], detail: string): string =>
  `result row=${lease.rowId} company=${lease.company ?? "-"} outcome=${outcome} detail=${detail.replace(/\s+/g, " ").slice(0, LOG_DETAIL_CHARS)}`;

const report = (deps: LoopDeps, lease: MacLease, outcome: ResultInput["outcome"], detail: string, proof?: Buffer): Promise<void> => {
  deps.log(outcomeLine(lease, outcome, detail));
  return deps.api.result({ rowId: lease.rowId, leaseId: lease.leaseId, outcome, detail, ...(proof ? { proofScreenshot: proof.toString("base64") } : {}) });
};

/** What to do with the page after a Submit click settled. Returns true when the tab should be closed. */
async function settle(deps: LoopDeps, lease: MacLease, session: FormSession, first: SubmitResult): Promise<boolean> {
  let res = first;
  if (res.kind === "challenge") {
    await report(deps, lease, "challenge", res.evidence);
    if (!(await waitForClear(deps, session))) {
      await report(deps, lease, "unconfirmed", "a challenge after Submit was not cleared within 30 min; check the tab before retrying");
      return false;
    }
    res = await session.afterChallenge();
  }
  if (res.kind === "confirmed") {
    await report(deps, lease, "confirmed", res.evidence, await session.proof());
    return true;
  }
  if (res.kind === "code-needed") {
    await report(deps, lease, "code_needed", res.evidence);
    return false;
  }
  await report(deps, lease, "unconfirmed", `Submit was clicked but nothing confirmed it. ${res.evidence} Check the tab before retrying.`);
  return false;
}

/** Reports `failed` and tells the caller to close the tab. */
async function giveUp(deps: LoopDeps, lease: MacLease, detail: string): Promise<boolean> {
  await report(deps, lease, "failed", detail);
  return true;
}

/** A dry run ends the lease without spending one of the row's attempts. */
async function dryRun(deps: LoopDeps, lease: MacLease, detail: string): Promise<boolean> {
  await report(deps, lease, "dry_run", detail);
  return true;
}

async function run(deps: LoopDeps, lease: MacLease, packet: MacPacket, session: FormSession): Promise<boolean> {
  const fill = await session.fill();
  if (!fill.ok) return giveUp(deps, lease, fill.reason);
  const limits = () => ({ dailyCap: deps.dailyCap, sentToday: deps.sentToday, now: deps.now() });
  // Everything except the bot check first, so the founder is never pinged for a form that cannot go out anyway.
  const base = sendGate(packet, fill.summary, false, limits());
  if (!base.ok) return giveUp(deps, lease, `not sent: ${base.reason}`);

  if (await session.challengeVisible()) {
    if (!deps.live) return dryRun(deps, lease, "a challenge is showing; live mode would report it and wait up to 30 min");
    await report(deps, lease, "challenge", "bot check visible on the form");
    if (!(await waitForClear(deps, session))) return giveUp(deps, lease, "challenge not cleared within 30 min");
  }
  const refusal = await session.preSubmitRefusal();
  if (refusal) return giveUp(deps, lease, `not sent: ${refusal}`);
  const gate = sendGate(packet, fill.summary, await session.challengeVisible(), limits());
  if (!gate.ok) return giveUp(deps, lease, `not sent: ${gate.reason}`);
  if (!deps.live) return dryRun(deps, lease, "every check passed, Submit not clicked");

  deps.sentToday += 1;
  return settle(deps, lease, session, await session.submit());
}

/** One leased row, end to end. Never throws: a crash is reported as failed so the lease is released. */
export async function processLease(deps: LoopDeps, first: MacLease): Promise<void> {
  let lease = first;
  let session: FormSession | null = null;
  let close = true;
  try {
    const packet = await deps.api.packet(lease);
    lease = { ...lease, company: packet.company };
    const cvPath = await deps.writeCv(packet, await deps.api.cv(lease));
    session = await deps.openSession(packet, cvPath);
    close = await run(deps, lease, packet, session);
  } catch (err) {
    deps.log(`row ${lease.rowId} crashed: ${(err as Error).message}`);
    // allow-failopen: if even the failure report cannot reach the VPS, the lease lapses on its own in 30 minutes.
    await report(deps, lease, "failed", `worker crashed: ${(err as Error).message}`).catch(() => undefined);
  } finally {
    // allow-failopen: a tab that will not close is the founder's to close; it must not stop the loop.
    if (session && close) await session.close().catch(() => undefined);
  }
}

/** Heartbeat, lease, process, repeat. `stop()` ends it between rows. */
export async function runWorker(deps: LoopDeps): Promise<void> {
  const beat = new Beater(deps);
  // allow-failopen: the first heartbeat failing (VPS unreachable) is retried by the loop below.
  await deps.api.heartbeat().catch(() => undefined);
  while (!deps.stop()) {
    await beat.tick();
    let lease: MacLease | null = null;
    try {
      lease = await deps.api.lease();
    } catch (err) {
      deps.log(`lease failed: ${(err as Error).message}`);
    }
    if (!lease) {
      await deps.sleep(IDLE_POLL_MS);
      continue;
    }
    deps.log(`leased ${lease.rowId}`);
    await processLease(deps, lease);
  }
}
