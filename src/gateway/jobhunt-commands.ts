/**
 * FounderOS — /draft and /ask
 * ===========================
 * The two commands that turn the daily job brief into an action.
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
 * Neither command sends anything. They compose an instruction and hand it to the
 * ordinary kernel turn, so drafting an email still stops at the HITL card
 * (ADR-018: the machine never submits an application).
 */

import type { Context } from "grammy";
import * as path from "node:path";
import { updateApplicationStage, type BriefSection } from "../db/job-queries.js";
import { listApplyQueue } from "../db/apply-queries.js";
import { askInstruction, draftInstruction } from "./jobhunt-instructions.js";
import { sendCoverLetter } from "./cover-letter-delivery.js";
import {
  buildApplicationPacket,
  resolveBriefRow,
  DRAFT_SECTIONS,
  type ApplicationPacket,
} from "../tools/jobhunt/apply-packet.js";
import { MAC_CLIENT_COMMAND } from "../tools/jobhunt/brief.js";
import { ARTIFACT_ROOT } from "../core/config.js";
import { threadIdFor } from "./kernel-run.js";
import { safeHtml } from "./approval-card.js";
import { childLogger } from "./../infra/logger.js";
import type { JobApplication } from "../db/schema.js";

const log = childLogger({ module: "gateway:jobhunt-commands" });

/**
 * Parse the row number out of "/draft 2".
 *
 * Returns null for anything that is not a plain positive integer. "2nd", "two"
 * and "" are all refusals rather than guesses — the cost of picking wrong is a
 * tailored application sent about the wrong company.
 */
export function parseRowArg(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/** How many rows one `/draft all` will tailor before it stops. */
export const BULK_DRAFT_CAP = 6;


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
export function parseDraftArg(raw: string): { rows: number[]; all: boolean } | null {
  const trimmed = raw.trim();
  if (/^all$/i.test(trimmed)) return { rows: [], all: true };
  if (trimmed.length === 0) return null;

  const parts = trimmed.split(/[,\s]+/).filter((p) => p.length > 0);
  const rows: number[] = [];
  for (const part of parts) {
    const n = parseRowArg(part);
    if (n === null) return null;
    if (!rows.includes(n)) rows.push(n);
  }
  return rows.length > 0 ? { rows, all: false } : null;
}

/**
 * Which sections each command addresses, in the words the brief prints them in.
 *
 * `/draft` spans two since 2026-08-06: DO TODAY and the stretch section share
 * one continuous numbering, because a row flagged only on the years bar needs an
 * APPLICATION, not a question. Naming only the first would tell the founder his
 * row is missing from a section it was never in.
 */
const COMMAND_SECTIONS: Readonly<Record<string, string>> = {
  draft: "DO TODAY / A STRETCH WORTH APPLYING TO",
  apply: "DO TODAY / A STRETCH WORTH APPLYING TO",
  applied: "DO TODAY / A STRETCH WORTH APPLYING TO",
  ask: "ONE QUESTION AWAY",
};

/** What to say when the number does not resolve. Never a silent no-op. */
export function unresolvedMessage(command: string, rank: number | null): string {
  if (rank === null) {
    return (
      `Usage: /${command} <number> — the number next to a row in the latest job brief.\n` +
      `Example: /${command} 1`
    );
  }
  return (
    `No row ${rank} in the latest brief's ${COMMAND_SECTIONS[command] ?? "actionable"} ` +
    `section.\n\nThe numbers come from the most recent brief only. Ask me for the job brief to ` +
    `get a current list.`
  );
}

export interface JobhuntCommandDeps {
  /** The normal kernel turn — same path a typed message takes. */
  readonly runKernelText: (ctx: Context, text: string) => Promise<void>;
}

async function handleRowCommand(
  ctx: Context,
  command: "draft" | "ask",
  sections: readonly BriefSection[],
  compose: (row: JobApplication) => string,
  deps: JobhuntCommandDeps,
): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage(command, null));
    return;
  }

  const row = await resolveBriefRow(rank, sections);
  if (!row) {
    await ctx.reply(unresolvedMessage(command, rank));
    return;
  }

  log.info({ command, rank, company: row.company, id: row.id }, "Brief row command resolved");
  await deps.runKernelText(ctx, compose(row));
}

/** The per-thread directory a tailored CV lands in before delivery. */
function artifactDirFor(ctx: Context): string {
  const safeThreadDir = threadIdFor(ctx.chat?.id ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(ARTIFACT_ROOT, safeThreadDir);
}

/**
 * The message that turns a delivered PDF into an application.
 *
 * SENT AS ITS OWN MESSAGE, with the apply URL as a tappable link. Everything
 * needed to finish is on one screen: where the form is, what to lead with, and
 * the command that closes the row out. Before this existed `/draft` ended with a
 * PDF and no next step, and prod bears out what that produced — 543 screened
 * rows, 2 applications, and not one `deliver_artifact` in the action log.
 *
 * The matched-skill count is printed because it is the one number that changes
 * a decision: a packet with 3 of 21 matched is worth reading before sending,
 * and one with 17 of 21 is worth sending first.
 */
export function packetMessage(packet: ApplicationPacket, rank: number): string {
  const { row } = packet;
  const asked = packet.matchedSkills.length + packet.missingSkills.length;
  const overlap =
    asked > 0 ? `${packet.matchedSkills.length}/${asked} of the skills it asks for` : "no skill list on the posting";

  const linkLine = packet.applyUrl.length === 0
    ? "⚠ No URL on file for this posting — search the company's careers page."
    : packet.opensTheForm
      ? `<a href="${safeHtml(packet.applyUrl)}">→ Open the application form</a>`
      : `<a href="${safeHtml(packet.applyUrl)}">→ Open the posting</a> <i>(this ATS hides the form behind its own button)</i>`;

  const top = packet.matchedSkills.slice(0, 6).join(", ");

  return (
    `<b>${rank}. ${safeHtml(row.company)} — ${safeHtml(row.title)}</b>\n` +
    `Permit basis: ${safeHtml(row.route)} · matches ${overlap}\n` +
    (top.length > 0 ? `Lead with: ${safeHtml(top)}\n` : "") +
    `\n${linkLine}\n\n` +
    `<i>Apply in the browser, then send</i> <code>/applied ${rank}</code><i> to clear it.</i>\n` +
    `<i>Or leave it queued and run</i> <code>${MAC_CLIENT_COMMAND}</code><i> on your Mac — it opens each queued role with the form already filled and waits for your click.</i>`
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
 * Produces a real tailored CV PDF, not just drafted text. Tailoring and
 * rendering happen here, outside the kernel — deterministic-enough work with no
 * side effects — and only the actual SEND goes through a kernel turn, so
 * `deliver_artifact`'s HITL gate still fires exactly as it does for every other
 * outbound file (ADR-018: the machine never sends without a tap).
 *
 * Rows are built SERIALLY. Each one is a worker-model call plus a Chromium
 * launch; running six in parallel would put six headless browsers on a 4GB VPS
 * and race the same `tailor_status` column.
 */
export async function handleDraft(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  const parsed = parseDraftArg(ctx.match?.toString() ?? "");
  if (parsed === null) {
    await ctx.reply(unresolvedMessage("draft", null));
    return;
  }

  const ranks = parsed.all ? await liveDraftRanks() : parsed.rows;
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

  for (const [i, rank] of capped.entries()) {
    await draftOneRow(ctx, rank, deps, capped.length > 1 ? `${i + 1}/${capped.length} · ` : "");
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
async function liveDraftRanks(): Promise<number[]> {
  const queue = await listApplyQueue();
  return queue
    .map((row) => row.brief_rank)
    .filter((rank): rank is number => typeof rank === "number")
    .sort((a, b) => a - b);
}

/** One row, end to end: tailor → cover letter → deliver → the packet message. */
async function draftOneRow(
  ctx: Context,
  rank: number,
  deps: JobhuntCommandDeps,
  progress: string,
): Promise<void> {
  const row = await resolveBriefRow(rank);
  if (!row) {
    await ctx.reply(unresolvedMessage("draft", rank));
    return;
  }

  log.info({ command: "draft", rank, company: row.company, id: row.id }, "Brief row command resolved");
  await ctx.reply(`📝 ${progress}Tailoring your CV for ${row.company}… this takes 20–40s.`);

  const built = await buildApplicationPacket(row, artifactDirFor(ctx));
  if (!built.ok) {
    log.warn(
      { id: row.id, company: row.company, reason: built.reason },
      "Tailored-PDF path failed — falling back to text draft",
    );
    await ctx.reply(
      `⚠ Couldn't build a tailored PDF for ${row.company} (${built.reason.slice(0, 200)}) — drafting a text application instead.`,
    );
    await deps.runKernelText(ctx, draftInstruction(row));
    return;
  }

  const { packet } = built;
  await sendCoverLetter(ctx, row, packet.cvMarkdown);

  await deps.runKernelText(
    ctx,
    `Call the deliver_artifact tool now with path="${packet.pdfPath}" and caption="Tailored CV — ${row.company} — ${row.title}". ` +
      `Do not do anything else — do not read the file, do not summarize it, do not compose any other message. ` +
      `Just call that one tool with exactly those two arguments.`,
  );

  // AFTER the delivery turn, not before: this message carries the apply link and
  // the close-out command, and it should be the last thing on screen when the
  // founder looks at the row.
  await ctx.reply(packetMessage(packet, rank), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** `/ask N` — write the one question that unblocks row N of ONE QUESTION AWAY. */
export async function handleAsk(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  await handleRowCommand(ctx, "ask", ["ask"], askInstruction, deps);
}

/**
 * `/applied N` — mark row N applied and drain it from the queue.
 *
 * A row the founder actually applied to must stop appearing in DO TODAY /
 * ASK / a stretch — `listActionableApplications` filters on `stage =
 * 'screened'`, so moving the stage is what removes it, the same mechanism
 * `/draft` and `/ask` never touch. No kernel turn: this is a plain state
 * change with nothing for a model to compose or approve.
 */
export async function handleApplied(ctx: Context): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage("applied", null));
    return;
  }

  const row = await resolveBriefRow(rank, DRAFT_SECTIONS);
  if (!row) {
    await ctx.reply(unresolvedMessage("applied", rank));
    return;
  }

  const updated = await updateApplicationStage(row.id, "applied", {
    appliedAt: new Date(),
    clearBriefRank: true,
  });
  if (!updated) {
    await ctx.reply(`Couldn't update ${row.company} — no row with id ${row.id} found. Nothing changed.`);
    return;
  }

  log.info({ command: "applied", rank, company: row.company, id: row.id }, "Application marked applied");
  await ctx.reply(`✅ Marked applied — ${row.company} (${row.title}). It's off today's queue.`);
}
