/**
 * Shadow apply: prepare every newly caught role's form after each free sweep and route it to a lane
 * ================================================================================================
 * Decision 2026-11-14: apply to every role that passes all gates, as soon as it is caught. This is the shadow
 * half: it OPENS and FILLS each form (prepareApplicationForm, which never clicks Submit), decides the lane
 * (apply-lane.ts), stores it on the row and sends one summary. Nothing reaches an employer. Opening the form
 * is the liveness check. Off unless AUTO_APPLY_SHADOW=on.
 *
 * Auto-send (ADR-018 amendment 2026-11-15): a row routed `auto` is handed to `deps.autoSend` only when
 * AUTO_APPLY_SEND=on, the profile's /autoapply switch is on and `canAutoSend` passes. With no `autoSend` dep or
 * either switch off, this pass is exactly the shadow pass: nothing reaches an employer.
 *
 * One browser at a time, at most AUTO_APPLY_PREPARE_PER_RUN forms opened per run (default 5, oldest first), so a
 * sweep tick cannot stall. Workday and other unsupported hosts are routed from the URL alone, with no browser.
 */

import { listLaneCandidates, claimLaneRow, recordLane } from "../../db/job-apply-lane-queries.js";
import type { JobApplication } from "../../db/schema.js";
import { childLogger } from "../../infra/logger.js";
import { routeLane, selectShadowBatch, type LaneCandidateRow, type LaneInput, type LaneVerdict } from "./apply-lane.js";
import { autoSendEnvOn, canAutoSend, dailyCapFrom, type AutoSendHistory, type AutoSendOutcomeLite } from "./auto-send-rules.js";
import type { FormPlanSummary } from "./form-filled.js";
import { applyProfilePathFor, readApplyProfile, type ApplyProfile } from "./apply-profile.js";
import { readCandidateDossier, type CandidateDossier } from "./candidate-dossier.js";
import { classifyFormUrl } from "./form-platform.js";
import { prepareApplicationForm } from "./form-runner.js";
import { listProfiles, type JobSearchProfile } from "./profile-config.js";
import { artifactDirForChat, resolveResumePdf } from "./resume-pdf.js";
import { formatShadowSummary, type ShadowRoutedRow } from "./shadow-apply-report.js";

/** What this pass reads off a job_applications row (a full JobApplication satisfies it). */
export type ShadowRow = Pick<JobApplication, "id" | "company" | "title" | "url" | "track"> & LaneCandidateRow;

const log = childLogger({ module: "shadow-apply" });
const DEFAULT_PER_RUN = 5;

export function shadowApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["AUTO_APPLY_SHADOW"] ?? "").trim().toLowerCase() === "on";
}

export function shadowPerRunCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env["AUTO_APPLY_PREPARE_PER_RUN"] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PER_RUN;
}

export interface ShadowDeps {
  readonly now: () => Date;
  readonly profiles: () => readonly JobSearchProfile[];
  readonly loadProfile: (profileId: string) => Promise<ApplyProfile | null>;
  readonly loadDossier: (profileId: string) => Promise<CandidateDossier | undefined>;
  readonly resumeFor: (row: ShadowRow, profile: JobSearchProfile, applyProfile: ApplyProfile) => Promise<string | undefined>;
  readonly candidates: (profileId: string, now: Date) => Promise<readonly ShadowRow[]>;
  readonly claim: (id: string, now: Date) => Promise<boolean>;
  readonly record: (id: string, verdict: LaneVerdict, now: Date) => Promise<void>;
  readonly prepare: typeof prepareApplicationForm;
  readonly send: (html: string) => Promise<void>;
  /** The auto-send half, wired in src/jobs (the send path lives in src/gateway). Absent: shadow only. */
  readonly autoSend?: {
    readonly runtimeOn: (profileId: string) => Promise<boolean>;
    readonly history: (profileId: string, now: Date) => Promise<AutoSendHistory>;
    readonly send: (row: ShadowRow, profileId: string, summary: FormPlanSummary) => Promise<AutoSendOutcomeLite>;
  };
}

/** Same chain as the manual path (tailored, configured, rendered from cv.md); $0, no model call. */
async function resumeIfPresent(row: ShadowRow, profile: JobSearchProfile, applyProfile: ApplyProfile): Promise<string | undefined> {
  const { jobsChatId } = await import("../../infra/telegram-send.js");
  const out = await resolveResumePdf(row, profile, applyProfile, artifactDirForChat(jobsChatId()));
  if (out.ok) return out.pdfPath;
  log.warn({ rowId: row.id, reason: out.reason }, "Shadow apply: no resume PDF resolved; the resume field stays unanswered");
  // allow-failopen: no resume file only means the resume field is reported as unanswered.
  return undefined;
}

export function realShadowDeps(): ShadowDeps {
  return {
    now: () => new Date(),
    profiles: listProfiles,
    loadProfile: async (id) => {
      const read = await readApplyProfile(applyProfilePathFor(id));
      return read.ok ? read.profile : null;
    },
    loadDossier: async (id) => (await readCandidateDossier(id)) ?? undefined,
    resumeFor: resumeIfPresent,
    candidates: listLaneCandidates,
    claim: claimLaneRow,
    record: (id, v, now) => recordLane(id, v.lane, v.reason, now),
    prepare: prepareApplicationForm,
    send: async (html) => {
      const { sendToJobsChat } = await import("../../infra/telegram-send.js");
      await sendToJobsChat(html, "HTML");
    },
  };
}

async function routeOne(
  deps: ShadowDeps,
  row: ShadowRow,
  jobsProfile: JobSearchProfile,
  profile: ApplyProfile,
  dossier: CandidateDossier | undefined,
): Promise<LaneInput> {
  const check = classifyFormUrl(row.url ?? "");
  if (!check.supported) return { kind: "failed", reason: check.reason, platform: null };
  try {
    const resumePath = await deps.resumeFor(row, jobsProfile, profile);
    // No coverLetterText: the letter is a paid call and shadow runs cost $0.
    const result = await deps.prepare(row.url ?? "", row.company, profile, resumePath ? { resumePath } : {}, dossier);
    return result.ok
      ? { kind: "prepared", platform: result.platform, summary: result.summary }
      : { kind: "failed", reason: result.reason, platform: result.platform ?? null };
  } catch (err) {
    // allow-failopen: a crashed form run is recorded on the row as a hand-off with its message.
    return { kind: "failed", reason: `form run crashed: ${(err as Error).message}`, platform: check.platform };
  }
}

/** Hand an `auto` row to the send path when both switches and the rules allow it; returns the verdict to record and report. */
async function maybeAutoSend(
  deps: ShadowDeps,
  env: NodeJS.ProcessEnv,
  row: ShadowRow,
  profileId: string,
  verdict: LaneVerdict,
  summary: FormPlanSummary,
): Promise<LaneVerdict> {
  const auto = deps.autoSend;
  if (!auto || verdict.lane !== "auto" || !autoSendEnvOn(env)) return verdict;
  try {
    const now = deps.now();
    const decision = canAutoSend(
      row,
      { ...verdict, summary },
      { envOn: true, runtimeOn: await auto.runtimeOn(profileId), dailyCap: dailyCapFrom(env), now },
      await auto.history(profileId, now),
    );
    if (!decision.ok) {
      log.info({ rowId: row.id, reason: decision.reason }, "Auto-send not allowed for this row");
      return { lane: "auto", reason: `${verdict.reason}; not auto-sent: ${decision.reason}` };
    }
    const out = await auto.send(row, profileId, summary);
    if (out.kind === "no-letter") {
      const needsYou: LaneVerdict = { lane: "needs_you", reason: out.detail };
      await deps.record(row.id, needsYou, deps.now());
      return needsYou;
    }
    return { lane: "auto", reason: out.kind === "sent" ? `auto-sent: ${out.detail}` : `${verdict.reason}; not auto-sent: ${out.detail}` };
  } catch (err) {
    // allow-failopen: a failed limit lookup or send crash leaves the row on the auto lane for the founder to send by hand.
    log.error({ rowId: row.id, err: (err as Error).message }, "Auto-send step failed; nothing further sent for this row");
    return { lane: "auto", reason: `${verdict.reason}; auto-send failed: ${(err as Error).message}` };
  }
}

export interface ShadowOutcome {
  readonly routed: readonly ShadowRoutedRow[];
  readonly opened: number;
}

/** One shadow pass over every profile. Never submits, never throws for one bad row. */
export async function runShadowApply(deps: ShadowDeps = realShadowDeps(), env: NodeJS.ProcessEnv = process.env): Promise<ShadowOutcome> {
  const cap = shadowPerRunCap(env);
  const routed: ShadowRoutedRow[] = [];
  let opened = 0;
  for (const profile of deps.profiles()) {
    const applyProfile = await deps.loadProfile(profile.id);
    if (!applyProfile) {
      log.warn({ profile: profile.id }, "Shadow apply skipped: no usable apply profile");
      continue;
    }
    const dossier = await deps.loadDossier(profile.id);
    const now = deps.now();
    const rows = selectShadowBatch(await deps.candidates(profile.id, now), now, cap - opened);
    for (const row of rows) {
      const needsBrowser = classifyFormUrl(row.url ?? "").supported;
      if (!(await deps.claim(row.id, deps.now()))) continue;
      if (needsBrowser) opened += 1;
      const input = await routeOne(deps, row, profile, applyProfile, dossier);
      const routedVerdict = routeLane(input);
      await deps.record(row.id, routedVerdict, deps.now());
      const verdict = input.kind === "prepared" ? await maybeAutoSend(deps, env, row, profile.id, routedVerdict, input.summary) : routedVerdict;
      routed.push({ company: row.company, title: row.title, profileId: profile.id, lane: verdict.lane, reason: verdict.reason });
    }
  }
  for (const message of formatShadowSummary(routed)) {
    try {
      await deps.send(message);
    } catch (err) {
      // allow-failopen: rows are already recorded; a Telegram failure must not fail the sweep tick.
      log.error({ err: (err as Error).message }, "Shadow apply summary could not be sent; lanes are stored on the rows");
    }
  }
  log.info({ opened, routed: routed.length, cap }, "Shadow apply pass complete");
  return { routed, opened };
}
