/**
 * FounderOS - the digest's apply-first layout (pure)
 * ==================================================
 * Pushkar and Tashi apply by hand: they open the link in a browser. The bot never learned they had, so prod
 * showed 2 rows with `applied_at` and none with `skipped_at`, while 117 of 261 new roles in a week were only
 * counted ("+N more") and never named.
 *
 * So the batch is now, per person (one name on every message, so the shared group chat never mixes them up):
 *   1. the top roles, numbered, with 📝 Draft / ✅ Applied / ⏭ Skip under each, and a one-line nudge;
 *   2. every other new role, named with its link, split over as many messages as it takes (repo rule #26).
 * The buttons only record state. Nothing is sent on anyone's behalf.
 */

import { formatBackfillLine } from "./sweep-heartbeat.js";
import { cmd, esc, link } from "./telegram-format.js";
import { jobCallbackData, shortJobId } from "./job-ref.js";

/** Roles that get the three buttons, per person. The rest are listed with a link and `/draft <id>`. */
export const DIGEST_APPLY_BUTTONS = 5;

/** Telegram's cap is 4,096; stay clear of it so a header and footer always fit. */
export const DIGEST_MESSAGE_MAX_CHARS = 3800;

export type DigestKeyboardRows = readonly (readonly { readonly text: string; readonly callback_data: string }[])[];

/** One new role, joined to its stored row when the lookup found it. */
export interface DigestRole {
  readonly key: string;
  readonly company: string;
  readonly title: string;
  readonly url: string | null;
  readonly outcome: "pass" | "flag";
  /** The stored row's full id. Null when the row could not be found: no button is built from a guess. */
  readonly rowId: string | null;
  readonly section: string | null;
  readonly fit: number | null;
}

export interface ApplyStats {
  readonly appliedWeek: number;
  readonly openDoToday: number;
}

export interface DigestMessage {
  readonly text: string;
  readonly keyboard?: DigestKeyboardRows;
}

/** Best first: do-today, then other clear roles by fit, then flagged ones. Stable inside a tier. */
export function rankRoles(roles: readonly DigestRole[]): DigestRole[] {
  const tier = (r: DigestRole): number => (r.section === "do_today" ? 0 : r.outcome === "pass" ? 1 : 2);
  return roles
    .map((r, i) => ({ r, i }))
    .sort((a, b) => tier(a.r) - tier(b.r) || (b.r.fit ?? -1) - (a.r.fit ?? -1) || a.i - b.i)
    .map((x) => x.r);
}

/** The short push to apply, recomputed from the database by the caller. Empty when the numbers are unavailable. */
export function nudgeLine(stats: ApplyStats | null): string {
  if (!stats) return "";
  const open = stats.openDoToday > 0 ? ` · open do-today roles: ${stats.openDoToday}` : "";
  return `Applied this week: ${stats.appliedWeek}${open}`;
}

/** Three buttons per top role. Every payload carries that role's own row id, so a tap can only touch that row. */
export function applyKeyboard(top: readonly DigestRole[]): DigestKeyboardRows {
  return top.flatMap((r, i) =>
    r.rowId === null
      ? []
      : [
          [
            { text: `📝 Draft ${i + 1}`, callback_data: jobCallbackData("draft", r.rowId) },
            { text: `✅ Applied ${i + 1}`, callback_data: jobCallbackData("applied", r.rowId) },
            { text: `⏭ Skip ${i + 1}`, callback_data: jobCallbackData("skipped", r.rowId) },
          ],
        ],
  );
}

const mark = (r: DigestRole): string => (r.outcome === "pass" ? "🟢" : "❓");
const roleLine = (r: DigestRole): string => `<b>${esc(r.company)}</b> — ${link(r.title, r.url)}`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface PersonInput {
  readonly name: string;
  /** `profileSelector(profile)`: printed in every command, empty for the default candidate. */
  readonly selector: string;
  readonly roles: readonly DigestRole[];
  /** Roles past the buffer cap: counted, never silently dropped. */
  readonly overflow: number;
  readonly backfill: number;
  readonly stats: ApplyStats | null;
}

/** All messages for one person, in send order. */
export function buildPersonMessages(p: PersonInput): DigestMessage[] {
  const who = `👤 <b>${esc(p.name)}</b>`;
  const sel = p.selector ? ` ${esc(p.selector)}` : "";
  const backfill = p.backfill > 0 ? formatBackfillLine(p.backfill, p.name, p.selector) : "";
  if (p.roles.length === 0) return [{ text: `${who}\n${backfill}` }];

  const ranked = rankRoles(p.roles);
  const top = ranked.slice(0, DIGEST_APPLY_BUTTONS);
  const rest = ranked.slice(DIGEST_APPLY_BUTTONS);
  const keyboard = applyKeyboard(top);
  const nudge = nudgeLine(p.stats);
  const total = p.roles.length + p.overflow;
  const first =
    `${who} — ${plural(total, "new role")}\n` +
    (nudge ? `<i>${nudge}</i>\n` : "") +
    `\n<b>Apply to these first</b>\n` +
    top.map((r, i) => `${i + 1}. ${mark(r)} ${roleLine(r)}`).join("\n") +
    (keyboard.length > 0 ? `\n\n<i>Tap ✅ after you apply, ⏭ if it's not for you.</i>` : "");
  const messages: DigestMessage[] = [{ text: first, ...(keyboard.length > 0 ? { keyboard } : {}) }];

  const footer = [
    p.overflow > 0 ? `+ ${p.overflow} more not listed: /jobs${sel}` : "",
    backfill,
    `→ /jobs${sel} for the ranked list`,
  ].filter(Boolean);
  const lines = rest.map((r) => {
    const id = r.rowId === null ? "" : ` · ${cmd(`/draft${sel} ${shortJobId(r.rowId)}`)}`;
    return `${mark(r)} ${roleLine(r)}${id}`;
  });
  const head = `${who} — more new roles`;
  const tail = "\n\n" + footer.join("\n");
  const budget = DIGEST_MESSAGE_MAX_CHARS - head.length - tail.length - 2;
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (cur.length > 0 && size + line.length + 1 > budget) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length > 0) chunks.push(cur);
  if (chunks.length === 0) {
    // Nothing left to list: the footer rides on the first message.
    messages[0] = { ...messages[0], text: first + tail } as DigestMessage;
    return messages;
  }
  chunks.forEach((chunk, i) => {
    const last = i === chunks.length - 1;
    messages.push({ text: `${head}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""}\n${chunk.join("\n")}${last ? tail : ""}` });
  });
  return messages;
}
