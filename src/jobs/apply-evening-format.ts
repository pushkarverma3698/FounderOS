/**
 * The 19:00 apply batch, as text and buttons (pure)
 * =================================================
 * One message per person (split when long) listing the roles the shadow apply pass routed to them that are still
 * open: "Needs you" first, then "Hand-off". One line per role: company, title, reason. The buttons only open a link,
 * start the existing prepare flow (`jh:f:`) or record state (the digest's Applied and Skip payloads). Nothing here
 * submits anything.
 */

import { esc, link, sanitizeTelegramUrl } from "../tools/jobhunt/telegram-format.js";
import { JOB_CALLBACK_PREFIX, jobCallbackData } from "../tools/jobhunt/job-ref.js";
import type { JobsChatButton } from "../infra/telegram-send.js";

/** Stay under Telegram's 4,096 with room for the header. */
export const EVENING_MESSAGE_MAX_CHARS = 3500;
/** Each role carries up to 4 buttons; Telegram allows 100 per message. */
export const EVENING_ROLES_PER_MESSAGE = 15;
const MAX_REASON_CHARS = 240;

export interface WaitingRole {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly url: string | null;
  readonly lane: "needs_you" | "hand_off";
  readonly reason: string;
  /** Signed answer-page link when a snapshot exists for the row; null falls back to the prepare button. */
  readonly answerUrl: string | null;
}

export interface EveningMessage {
  readonly text: string;
  readonly keyboard: readonly (readonly JobsChatButton[])[];
}

const clip = (t: string): string => (t.length > MAX_REASON_CHARS ? `${t.slice(0, MAX_REASON_CHARS - 1)}…` : t);
const SECTION_TITLE = { needs_you: "Needs you", hand_off: "Hand-off" } as const;

/** Needs you first, then hand-off; the input order is kept inside each group. */
export function orderRoles(roles: readonly WaitingRole[]): WaitingRole[] {
  return [...roles.filter((r) => r.lane === "needs_you"), ...roles.filter((r) => r.lane === "hand_off")];
}

function roleLine(n: number, r: WaitingRole): string {
  return `${n}. <b>${esc(r.company)}</b> — ${link(r.title, r.url)} — ${esc(clip(r.reason.trim() || "no reason recorded"))}`;
}

/** Buttons for role number `n`: the way in (answer page or prepare), the job link, then Applied and Skip. */
export function roleButtons(n: number, r: WaitingRole): JobsChatButton[][] {
  const entry: JobsChatButton =
    r.lane === "needs_you"
      ? r.answerUrl
        ? { text: `✍ Answer ${n}`, url: r.answerUrl }
        : { text: `🚀 Prepare ${n}`, callback_data: `${JOB_CALLBACK_PREFIX}f:${r.id}` }
      : r.answerUrl
        ? { text: `📋 Copy answers ${n}`, url: `${r.answerUrl.replace(/\/+$/, "")}/handoff` }
        : { text: `📋 Copy answers ${n}`, callback_data: `${JOB_CALLBACK_PREFIX}f:${r.id}` };
  const posting = sanitizeTelegramUrl(r.url);
  const first: JobsChatButton[] = posting ? [entry, { text: `🔗 Job ${n}`, url: posting }] : [entry];
  return [
    first,
    [
      { text: `✅ Applied ${n}`, callback_data: jobCallbackData("applied", r.id) },
      { text: `⏭ Skip ${n}`, callback_data: jobCallbackData("skipped", r.id) },
    ],
  ];
}

/** All messages for one person, in send order. Empty when nothing waits: nothing is sent. */
export function buildEveningMessages(name: string, roles: readonly WaitingRole[]): EveningMessage[] {
  if (roles.length === 0) return [];
  const ordered = orderRoles(roles).map((role, i) => ({ role, n: i + 1, line: roleLine(i + 1, role) }));
  const chunks: (typeof ordered)[] = [];
  let cur: typeof ordered = [];
  let size = 0;
  for (const item of ordered) {
    const cost = item.line.length + 40;
    if (cur.length > 0 && (size + cost > EVENING_MESSAGE_MAX_CHARS || cur.length >= EVENING_ROLES_PER_MESSAGE)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += cost;
  }
  if (cur.length > 0) chunks.push(cur);

  const who = `🌙 <b>${esc(name)}</b>`;
  return chunks.map((chunk, i) => {
    const head = `${who} — ${roles.length} role${roles.length === 1 ? "" : "s"} still waiting on you${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""}`;
    const body: string[] = [];
    let section: WaitingRole["lane"] | null = null;
    for (const { role, line } of chunk) {
      if (role.lane !== section) {
        section = role.lane;
        body.push(`\n<b>${SECTION_TITLE[section]}</b>`);
      }
      body.push(line);
    }
    return {
      text: `${head}\n${body.join("\n")}\n\n<i>Tap ✅ after you apply, ⏭ if it's not for you.</i>`,
      keyboard: chunk.flatMap(({ role, n }) => roleButtons(n, role)),
    };
  });
}
