/**
 * The 19:00 evening apply batch (runner)
 * ======================================
 * Shadow apply (src/tools/jobhunt/shadow-apply.ts) stores where each prepared role landed. Once a day, at 19:00
 * Amsterdam, each profile gets ONE message (split when long) with what still waits on them. Nothing waiting, nothing
 * sent. Off unless APPLY_EVENING_BATCH=on.
 *
 * One batch per profile per day: a marker file is created atomically (`wx`) BEFORE the send, so a restart or an
 * overlapping tick at 19:00 cannot send twice, and removed again if the send fails, so the next tick can retry.
 * The chat is the one the digest uses (`sendToJobsChat`), so Tashi's rows go where her digest goes.
 */

import fs from "node:fs";
import path from "node:path";
import type { JobApplication } from "../db/schema.js";
import { dataRoot } from "../core/data-root.js";
import { childLogger } from "../infra/logger.js";
import { sendToJobsChat } from "../infra/telegram-send.js";
import { listProfiles, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { buildApplyUrl, loadApplySnapshot, readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { buildEveningMessages, type EveningMessage, type WaitingRole } from "./apply-evening-format.js";

const log = childLogger({ module: "apply-evening-batch" });

export const EVENING_CRON = "0 19 * * *";
export const EVENING_TIME_ZONE = "Europe/Amsterdam";

export function eveningBatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["APPLY_EVENING_BATCH"] ?? "").trim().toLowerCase() === "on";
}

export interface EveningDeps {
  readonly profiles: () => readonly JobSearchProfile[];
  readonly waiting: (profileId: string, now: Date) => Promise<readonly JobApplication[]>;
  /** The signed answer link for a row, or null when none can be built. */
  readonly answerUrl: (row: JobApplication, now: Date) => string | null;
  readonly send: (message: EveningMessage) => Promise<void>;
  /** True when this caller won today's marker for the profile. */
  readonly claim: (profileId: string, now: Date) => boolean;
  readonly release: (profileId: string, now: Date) => void;
}

/** The local calendar date in Amsterdam, so "today" does not move with the server's UTC clock. */
export function eveningDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: EVENING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function markerPath(profileId: string, now: Date): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(dataRoot(), "apply-evening-batch", `${eveningDay(now)}-${safe}.sent`);
}

function claimMarker(profileId: string, now: Date): boolean {
  const file = markerPath(profileId, now);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(file, "wx", 0o600));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function releaseMarker(profileId: string, now: Date): void {
  fs.rmSync(markerPath(profileId, now), { force: true });
}

async function realDeps(): Promise<EveningDeps> {
  const { listWaitingLaneRows } = await import("../db/job-apply-lane-queries.js");
  return {
    profiles: listProfiles,
    waiting: listWaitingLaneRows,
    answerUrl: (row, now) => {
      const cfg = readApplyLinkConfig();
      const snap = loadApplySnapshot(row.id);
      return cfg.ok && snap && snap.profileId === row.profile_id ? buildApplyUrl(cfg, row.id, row.profile_id, now.getTime()) : null;
    },
    send: (m) => sendToJobsChat(m.text, "HTML", m.keyboard),
    claim: claimMarker,
    release: releaseMarker,
  };
}

const toRole = (row: JobApplication, answerUrl: string | null): WaitingRole => ({
  id: row.id,
  company: row.company,
  title: row.title,
  url: row.url ?? null,
  lane: row.apply_lane === "needs_you" ? "needs_you" : "hand_off",
  reason: row.apply_lane_reason ?? "",
  answerUrl,
});

async function batchFor(profile: JobSearchProfile, now: Date, d: EveningDeps): Promise<EveningMessage[]> {
  const rows = await d.waiting(profile.id, now);
  const first = profile.candidateName.trim().split(/\s+/)[0] ?? profile.candidateName;
  return buildEveningMessages(first, rows.map((r) => toRole(r, d.answerUrl(r, now))));
}

/** Send each profile's batch. Returns how many profiles got one. One profile failing never blocks the others. */
export async function runEveningBatch(now: Date = new Date(), deps?: EveningDeps): Promise<number> {
  if (!eveningBatchEnabled()) return 0;
  const d = deps ?? (await realDeps());
  let sent = 0;
  for (const profile of d.profiles()) {
    let claimed = false;
    try {
      const messages = await batchFor(profile, now, d);
      if (messages.length === 0) continue;
      if (!d.claim(profile.id, now)) {
        log.info({ profile: profile.id }, "Evening batch already sent today; skipping");
        continue;
      }
      claimed = true;
      for (const m of messages) await d.send(m);
      sent += 1;
      log.info({ profile: profile.id, messages: messages.length }, "Evening apply batch sent");
    } catch (err) {
      // allow-failopen: one profile's failure is logged loudly and must not stop the next profile's batch.
      log.error({ profile: profile.id, err: (err as Error).message }, "Evening apply batch failed");
      if (claimed) d.release(profile.id, now);
    }
  }
  return sent;
}
