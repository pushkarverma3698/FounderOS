/**
 * FounderOS — /draft and /applied
 * ===============================
 * The commands that turn the daily job brief into an action.
 *
 * The brief prints "1. Aquablu B.V — Embedded Software Engineer … → /draft 1".
 * Without these handlers that arrow points at nothing: grammy drops unregistered
 * slash commands, and the gateway's text handler returns early on anything
 * starting with "/", so the founder would tap the one control the brief offers
 * and receive complete silence.
 *
 * Resolution is PURE CODE, not a model call. The rank was pinned to a row when
 * the brief rendered, so `/draft 2` can only ever mean the row printed as 2.
 * Asking a model to work out which job "2" meant would be a guess with an
 * application riding on it.
 *
 * Neither command submits anything (ADR-018: the machine never submits an
 * application). There is no kernel since 2026-10-10: `/ask` and the text-draft
 * fallback went with it, so a failed PDF build now says so and stops.
 */

import { InputFile, type Context } from "grammy";
import * as path from "node:path";
import { markRowApplied, packetKeyboard } from "./jobhunt-buttons.js";
import { listApplyQueue } from "../db/apply-queries.js";
import {
  resolveProfileArg,
  isProfileArgMiss,
  profileMissMessage,
} from "./jobhunt-profile-arg.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { sendCoverLetter } from "./cover-letter-delivery.js";
import {
  buildApplicationPacket,
  DRAFT_SECTIONS,
  type ApplicationPacket,
} from "../tools/jobhunt/apply-packet.js";
import { truncateAtWord } from "../tools/jobhunt/telegram-format.js";
import { ARTIFACT_ROOT, TENANT } from "../core/config.js";
import { safeHtml } from "./safe-html.js";
import { childLogger } from "./../infra/logger.js";
import type { JobApplication } from "../db/schema.js";
import { idRef, parseRowArg, parseRowRef, rankRef, resolveRowRef, unresolvedMessage, type RowRef } from "./jobhunt-row-ref.js";

// The row-reference parsers moved to jobhunt-row-ref.js; callers still import them from here.
export { parseRowArg, unresolvedMessage };

const log = childLogger({ module: "gateway:jobhunt-commands" });

/**
 * How much of a packet-build failure reason reaches the founder.
 *
 * Wide enough for the claim guard's full summary (a count plus every ungrounded
 * claim, grouped by kind) rather than the first sentence and a half of it.
 */
const DRAFT_FAILURE_REASON_CHARS = 400;

/** How many rows one `/draft all` will tailor before it stops. */
export const BULK_DRAFT_CAP = 6;

export interface DraftArg {
  /** Row numbers from the latest brief. */
  readonly rows: number[];
  /** Ids an alert printed, as hex prefixes. Absent when none were typed. */
  readonly ids?: string[];
  readonly all: boolean;
}

/**
 * Parse the argument of `/draft` into the list of rows to build.
 *
 * Three forms, because the founder asked for all three and the cost of only
 * supporting the first is that a queue of ten roles takes ten round trips:
 *
 *   `/draft 2`      → [2]
 *   `/draft 1,3,5`  → [1, 3, 5]
 *   `/draft all`    → [] with `all: true`, resolved against the live brief
 *
 * A partially valid list is a REFUSAL, not a best-effort subset. "1,x,3" almost
 * certainly means the founder mistyped a row he wants, and quietly dropping it
 * would tailor two of the three applications he asked for and say nothing about
 * the third.
 */
export function parseDraftArg(raw: string): DraftArg | null {
  const trimmed = raw.trim();
  if (/^all$/i.test(trimmed)) return { rows: [], all: true };
  if (trimmed.length === 0) return null;

  const parts = trimmed.split(/[,\s]+/).filter((p) => p.length > 0);
  const rows: number[] = [];
  const ids: string[] = [];
  for (const part of parts) {
    const ref = parseRowRef(part);
    if (ref === null) return null;
    if (ref.kind === "rank" && !rows.includes(ref.rank)) rows.push(ref.rank);
    if (ref.kind === "id" && !ids.includes(ref.hex)) ids.push(ref.hex);
  }
  if (rows.length + ids.length === 0) return null;
  return ids.length > 0 ? { rows, ids, all: false } : { rows, all: false };
}

/** The per-thread directory a tailored CV lands in before delivery. */
function artifactDirFor(ctx: Context): string {
  const safeThreadDir = `${TENANT}:${ctx.chat?.id ?? "unknown"}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(ARTIFACT_ROOT, safeThreadDir);
}

/**
 * The message that turns a delivered PDF into an application.
 *
 * SENT AS ITS OWN MESSAGE with two buttons (see `packetKeyboard`): open the form,
 * then ✅ I applied. No shell command and no typed `/applied N`: both were
 * unusable on a phone, and prod bears out what that produced: 543 screened rows,
 * 2 applications, not one `deliver_artifact` in the action log.
 *
 * The matched-skill count is printed because it is the one number that changes
 * a decision: a packet with 3 of 21 matched is worth reading before sending,
 * and one with 17 of 21 is worth sending first.
 */
export function packetMessage(packet: ApplicationPacket, rank?: number): string {
  const { row } = packet;
  const asked = packet.matchedSkills.length + packet.missingSkills.length;
  const overlap =
    asked > 0 ? `${packet.matchedSkills.length}/${asked} of the skills it asks for` : "no skill list on the posting";

  const linkLine = packet.applyUrl.length === 0
    ? "⚠ No URL on file for this posting — search the company's careers page."
    : packet.opensTheForm
      ? "Tap <b>Open the form</b>, send the CV above, then tap <b>I applied</b>."
      : "Tap <b>Open the form</b> <i>(this ATS hides the form behind its own button)</i>, send the CV above, then tap <b>I applied</b>.";

  const top = packet.matchedSkills.slice(0, 6).join(", ");

  return (
    `<b>${rank === undefined ? "" : `${rank}. `}${safeHtml(row.company)} — ${safeHtml(row.title)}</b>\n` +
    `Permit basis: ${safeHtml(row.route)} · matches ${overlap}\n` +
    (top.length > 0 ? `Lead with: ${safeHtml(top)}\n` : "") +
    `\n${linkLine}`
  );
}

/**
 * `/draft N`, `/draft 1,3,5`, `/draft all` — build the application(s).
 *
 * DO TODAY and the stretch section both, because both end in an application. A
 * row flagged only on the years bar is not a question for the employer — asking
 * whether "5+ years" is firm invites a pre-emptive rejection on the one gate
 * written as a wish.
 *
 * Produces a real tailored CV PDF, not just drafted text. Tailoring, rendering
 * and the send all happen here, outside the kernel: the PDF goes back into the
 * chat that typed the command, so no approval card guards it (nothing leaves
 * Telegram; applying stays the founder's own click — ADR-018).
 *
 * Rows are built SERIALLY. Each one is a worker-model call plus a Chromium
 * launch; running six in parallel would put six headless browsers on a 4GB VPS
 * and race the same `tailor_status` column.
 */
export async function handleDraft(ctx: Context): Promise<void> {
  // "all" belongs to parseDraftArg, so it is reserved before the profile lookup.
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", ["all"], (rest) =>
    parseDraftArg(rest) !== null,
  );
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const parsed = parseDraftArg(selected.rest);
  if (parsed === null) {
    await ctx.reply(unresolvedMessage("draft", null));
    return;
  }

  const ranks = parsed.all ? (await liveDraftRanks(selected.profile)).map(rankRef) : [...parsed.rows.map(rankRef), ...(parsed.ids ?? []).map(idRef)];
  if (ranks.length === 0) {
    await ctx.reply(
      parsed.all
        ? "Nothing is queued to apply to right now. Ask me for the job brief, or send /jobs to rank the queue again."
        : unresolvedMessage("draft", null),
    );
    return;
  }

  const capped = ranks.slice(0, BULK_DRAFT_CAP);
  if (ranks.length > capped.length) {
    await ctx.reply(
      `${ranks.length} rows are queued — building the first ${capped.length}. ` +
        `Send /draft ${capped.length + 1},${capped.length + 2} for the rest.`,
    );
  }

  for (const [i, ref] of capped.entries()) {
    await draftOneRow(ctx, ref, capped.length > 1 ? `${i + 1}/${capped.length} · ` : "", selected.profile);
  }
}

/**
 * The rows `/draft all` resolves to — whatever the LIVE brief currently pins.
 *
 * Read from the ranks themselves rather than from a cap constant: the brief's
 * section caps have changed twice, and a hard-coded 1..10 here would either
 * silently skip rows or spend a model call resolving numbers that point at
 * nothing.
 */
async function liveDraftRanks(profile: JobSearchProfile): Promise<number[]> {
  const queue = await listApplyQueue(profile.tenantId, profile.id);
  return queue
    .map((row) => row.brief_rank)
    .filter((rank): rank is number => typeof rank === "number")
    .sort((a, b) => a - b);
}

/** One row, end to end: tailor → cover letter → deliver → the packet message. */
async function draftOneRow(
  ctx: Context,
  ref: RowRef,
  progress: string,
  profile: JobSearchProfile,
): Promise<void> {
  const resolved = await resolveRowRef(ref, "draft", DRAFT_SECTIONS, profile);
  if (!resolved.ok) {
    await ctx.reply(resolved.message);
    return;
  }
  await draftRow(ctx, resolved.row, progress, profile, ref.kind === "rank" ? ref.rank : undefined);
}

/** Build the application for a resolved row; shared by `/draft N` and the 📝 Draft button. */
export async function draftRow(
  ctx: Context,
  row: JobApplication,
  progress: string,
  profile: JobSearchProfile,
  rank?: number,
): Promise<void> {
  log.info(
    { command: "draft", rank, company: row.company, id: row.id, profile: profile.id },
    "Brief row command resolved",
  );
  await ctx.reply(`📝 ${progress}Tailoring your CV for ${row.company}… this takes 20–40s.`);

  const built = await buildApplicationPacket(row, artifactDirFor(ctx));
  if (!built.ok) {
    log.warn(
      { id: row.id, company: row.company, reason: built.reason },
      "Tailored-PDF path failed",
    );
    // truncateAtWord, not .slice: prod 2026-09-07 clipped the claim-guard's
    // reason mid-word (`... [technology] "TD)`), hiding the rest of the list of
    // ungrounded claims — the only actionable content in the message.
    await ctx.reply(
      `⚠ Couldn't build a tailored PDF for ${row.company} (${truncateAtWord(built.reason, DRAFT_FAILURE_REASON_CHARS)}). ` +
        `Nothing was drafted. Send /draft again to retry, or apply with your base CV.`,
    );
    return;
  }

  const { packet } = built;
  await sendCoverLetter(ctx, row, packet.cvMarkdown);

  // Straight into the chat that typed /draft — no kernel turn, no approval card.
  // Nothing leaves Telegram: applying is still the founder's own click on the
  // employer's form. The kernel route cost three model calls and a tap, sent to
  // the founder's DM even when /wife_draft came from the family group, and on
  // 2026-09-17 its synthesizer reported a delivered CV as failed.
  await ctx.replyWithDocument(new InputFile(packet.pdfPath, path.basename(packet.pdfPath)), {
    caption: `Tailored CV — ${row.company} — ${row.title}`,
  });

  // AFTER the delivery turn, not before: this message carries the apply link and
  // the close-out command, and it should be the last thing on screen when the
  // founder looks at the row.
  await ctx.reply(packetMessage(packet, rank), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: packetKeyboard(row.id, packet.applyUrl),
  });
}

/**
 * `/applied N` — mark row N applied and drain it from the queue.
 *
 * A row the founder actually applied to must stop appearing in DO TODAY /
 * ASK / a stretch — `listActionableApplications` filters on `stage =
 * 'screened'`, so moving the stage is what removes it. A plain state change
 * with nothing for a model to compose or approve.
 */
export async function handleApplied(ctx: Context): Promise<void> {
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", [], (rest) => parseRowRef(rest) !== null);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const ref = parseRowRef(selected.rest);
  if (ref === null) {
    await ctx.reply(unresolvedMessage("applied", null));
    return;
  }

  const resolved = await resolveRowRef(ref, "applied", DRAFT_SECTIONS, selected.profile);
  if (!resolved.ok) {
    await ctx.reply(resolved.message);
    return;
  }
  const { row } = resolved;

  const result = await markRowApplied(row);
  if (!result.ok) {
    await ctx.reply(`Couldn't update ${row.company} — no row with id ${row.id} found. Nothing changed.`);
    return;
  }

  log.info({ command: "applied", ref, company: row.company, id: row.id }, "Application marked applied");
  await ctx.reply(`✅ Marked applied — ${row.company} (${row.title}). It's off today's queue.`);
}
