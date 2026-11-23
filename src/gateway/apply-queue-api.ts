/**
 * Apply queue: the JSON for `GET /apply/api/queue`
 * ================================================
 * The signed-in profile's open roles in the four groups (tools/jobhunt/apply-queue.ts), each with what its buttons
 * need: the job link, the signed answer link (only when a snapshot exists, because every action runs under it), the
 * snapshot stamp the existing Submit endpoint asks for, and whether Submit would be accepted now (an answer row whose re-fill left nothing open can be sent too). Reads only; the
 * page's actions call the existing answer, hand-off and submit endpoints.
 */

import type { JobApplication } from "../db/schema.js";
import { dropNoEmployerLink } from "../tools/jobhunt/aggregator-apply-url.js";
import { buildApplyUrl, loadApplySnapshot, readApplyLinkConfig, type ApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { QUEUE_GROUPS, QUEUE_GROUP_TITLE, countQueue, queueGroupOf, type QueueGroup } from "../tools/jobhunt/apply-queue.js";
import { sanitizeTelegramUrl } from "../tools/jobhunt/telegram-format.js";
import { macOnline } from "../tools/jobhunt/mac-worker-rules.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { computeStatus, type ApiDeps } from "./apply-api.js";
import { applyFieldName, isEditableQuestion } from "./apply-page.js";

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
  /** Answer rows with exactly one open required question: the question, its form field name and any draft. */
  readonly question?: QueueQuestion;
  /** Mac rows: what to tell him, from the worker's heartbeat. */
  readonly macNote?: string;
}

export interface QueueQuestion {
  readonly label: string;
  /** The answer page's hashed field name, so Save posts through the same form the answer page posts. */
  readonly field: string;
  readonly fieldType: string;
  readonly options?: readonly string[];
  /** The earlier try recorded in the snapshot (triedAnswer); nothing is generated at page time. */
  readonly draft?: string;
}

export interface QueueDeps {
  readonly rows: (profile: JobSearchProfile, now: Date) => Promise<readonly JobApplication[]>;
  readonly macBeat: () => Promise<Date | null>;
}

// jobUrl is a scraped URL that lands in an href, so only http(s) passes (sanitizeTelegramUrl).
const clip = (t: string): string => (t.length > MAX_REASON_CHARS ? `${t.slice(0, MAX_REASON_CHARS - 1)}…` : t);

export const macNoteFor = (online: boolean): string => (online ? "Click the check on your Mac." : "Mac offline. This waits until it is back on.");

/** The one open required question of a snapshot, when there is exactly one and the page can take an answer to it. */
export function oneQuestionOf(snap: ApplySnapshot | null): QueueQuestion | undefined {
  const open = snap?.summary.unanswered.filter((q) => q.required) ?? [];
  const q = open.length === 1 ? open[0] : undefined;
  if (!q || !isEditableQuestion(q)) return undefined;
  return { label: q.label, field: applyFieldName(q.label), fieldType: q.fieldType, ...(q.options?.length ? { options: q.options } : {}), ...(q.triedAnswer ? { draft: q.triedAnswer } : {}) };
}

const questionField = (snap: ApplySnapshot | null): { question?: QueueQuestion } => {
  const question = oneQuestionOf(snap);
  return question ? { question } : {};
};

/**
 * Group order, then the rows he can act on now first (Send possible, or a one-question row), then the oldest snapshot
 * first so nothing waits behind newer rows, then company for a stable list.
 */
export function orderQueue(items: readonly QueueItem[]): QueueItem[] {
  const rank = (i: QueueItem): number => (i.canSend || i.question ? 0 : 1);
  return [...items].sort((a, b) =>
    QUEUE_GROUPS.indexOf(a.group) - QUEUE_GROUPS.indexOf(b.group) || rank(a) - rank(b)
    || (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || a.company.localeCompare(b.company));
}

export async function buildQueue(profile: JobSearchProfile, deps: ApiDeps, q: QueueDeps) {
  const now = new Date(deps.now());
  const cfg = readApplyLinkConfig(deps.env);
  // Same rule as the evening digest: Himalayas/Jobicy hand-offs have no employer link, so they are not listed.
  const open = dropNoEmployerLink((await q.rows(profile, now)).filter((r) => r.profile_id === profile.id)).rows;
  const macOk = macOnline(await q.macBeat(), now);
  const items: QueueItem[] = [];
  for (const r of open) {
    const group = queueGroupOf(r);
    if (!group) continue;
    const snap = loadApplySnapshot(r.id, deps.root);
    const mine = snap !== null && snap.profileId === profile.id && cfg.ok;
    items.push({
      id: r.id, group, company: r.company, title: r.title, jobUrl: sanitizeTelegramUrl(r.url) ?? "", reason: clip((r.apply_lane_reason ?? "").trim()),
      ...(mine ? { answerUrl: buildApplyUrl(cfg, r.id, profile.id, now.getTime()), createdAt: snap.createdAt } : {}),
      canSend: (group === "ready" || group === "answer") && mine && computeStatus(r.id, snap, now.getTime())?.state === "ready",
      ...(group === "answer" && mine ? questionField(snap) : {}),
      ...(group === "mac" ? { macNote: macNoteFor(macOk) } : {}),
    });
  }
  return {
    counts: countQueue(open),
    groups: QUEUE_GROUPS.map((id) => ({ id, title: QUEUE_GROUP_TITLE[id] })),
    items: orderQueue(items),
    macOnline: macOk,
  };
}
