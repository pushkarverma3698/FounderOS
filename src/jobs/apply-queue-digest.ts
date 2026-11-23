/**
 * The daily apply digest: one message with counts and one button (pure)
 * =====================================================================
 * Replaces one card per role. The counts come from the same four groups the Mini App queue lists
 * (tools/jobhunt/apply-queue.ts), so the message and the page cannot disagree. The button opens the queue.
 * Nothing waiting: no message.
 */

import type { JobsChatButton } from "../infra/telegram-send.js";
import { countQueue, queueTotal, type QueueLaneFields } from "../tools/jobhunt/apply-queue.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import type { EveningMessage } from "./apply-evening-format.js";

export interface QueueLink {
  /** The public address of the queue page, or null when the apply link config is incomplete. */
  readonly url: string | null;
  /** True when Telegram can open the address as a Mini App (private chat, https). */
  readonly inTelegram: boolean;
  /** False when the Mac worker has not checked in recently. */
  readonly macOnline: boolean;
}

export function buildQueueDigest(name: string, rows: readonly QueueLaneFields[], link: QueueLink): EveningMessage | null {
  const c = countQueue(rows);
  const total = queueTotal(c);
  if (total === 0) return null;
  const lines = [`🌙 <b>${esc(name)}</b>: ${total} role${total === 1 ? "" : "s"} waiting`];
  if (c.ready > 0) lines.push(`✅ ${c.ready} ready to send`);
  if (c.answer > 0) lines.push(`✍ ${c.answer} need${c.answer === 1 ? "s" : ""} one answer`);
  if (c.mac > 0) lines.push(`🖱 ${c.mac} need${c.mac === 1 ? "s" : ""} a click on your Mac${link.macOnline ? "" : " (Mac offline)"}`);
  if (c.site > 0) lines.push(`🌐 ${c.site} need${c.site === 1 ? "s" : ""} you on the site`);
  if (!link.url) lines.push("The queue link is not configured, so open the Jobs list from the menu.");
  const button: JobsChatButton | null = link.url
    ? link.inTelegram ? { text: "Open the queue", web_app: { url: link.url } } : { text: "Open the queue", url: link.url }
    : null;
  return { text: lines.join("\n"), keyboard: button ? [[button]] : [] };
}
