/**
 * Apply queue: the JSON for `GET /apply/api/queue`
 * ================================================
 * The signed-in profile's open roles in the four groups (tools/jobhunt/apply-queue.ts), each with what its buttons
 * need: the job link, the signed answer link (only when a snapshot exists, because every action runs under it), the
 * snapshot stamp the existing Submit endpoint asks for, and whether Submit would be accepted now. Reads only; the
 * page's actions call the existing answer, hand-off and submit endpoints.
 */

import type { JobApplication } from "../db/schema.js";
import { dropNoEmployerLink } from "../tools/jobhunt/aggregator-apply-url.js";
import { buildApplyUrl, loadApplySnapshot, readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { QUEUE_GROUPS, QUEUE_GROUP_TITLE, countQueue, queueGroupOf, type QueueGroup } from "../tools/jobhunt/apply-queue.js";
import { macOnline } from "../tools/jobhunt/mac-worker-rules.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { computeStatus, type ApiDeps } from "./apply-api.js";

const MAX_REASON_CHARS = 240;

export interface QueueItem {
  readonly id: string;
  readonly group: QueueGroup;
  readonly company: string;
  readonly title: string;
  readonly jobUrl: string;
  readonly reason: string;
  readonly answerUrl?: string;
  readonly createdAt?: number;
  readonly canSend: boolean;
}

export interface QueueDeps {
  readonly rows: (profile: JobSearchProfile, now: Date) => Promise<readonly JobApplication[]>;
  readonly macBeat: () => Promise<Date | null>;
}

const clip = (t: string): string => (t.length > MAX_REASON_CHARS ? `${t.slice(0, MAX_REASON_CHARS - 1)}…` : t);

export async function buildQueue(profile: JobSearchProfile, deps: ApiDeps, q: QueueDeps) {
  const now = new Date(deps.now());
  const cfg = readApplyLinkConfig(deps.env);
  // Same rule as the evening digest: Himalayas/Jobicy hand-offs have no employer link, so they are not listed.
  const open = dropNoEmployerLink((await q.rows(profile, now)).filter((r) => r.profile_id === profile.id)).rows;
  const items: QueueItem[] = [];
  for (const r of open) {
    const group = queueGroupOf(r);
    if (!group) continue;
    const snap = loadApplySnapshot(r.id, deps.root);
    const mine = snap !== null && snap.profileId === profile.id && cfg.ok;
    items.push({
      id: r.id, group, company: r.company, title: r.title, jobUrl: r.url ?? "", reason: clip((r.apply_lane_reason ?? "").trim()),
      ...(mine ? { answerUrl: buildApplyUrl(cfg, r.id, profile.id, now.getTime()), createdAt: snap.createdAt } : {}),
      canSend: group === "ready" && mine && computeStatus(r.id, snap, now.getTime())?.state === "ready",
    });
  }
  return {
    counts: countQueue(open),
    groups: QUEUE_GROUPS.map((id) => ({ id, title: QUEUE_GROUP_TITLE[id] })),
    items,
    macOnline: macOnline(await q.macBeat(), now),
  };
}
