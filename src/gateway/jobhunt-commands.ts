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
 * (ADR-009: the machine never submits an application).
 */

import type { Context } from "grammy";
import { getApplicationByBriefRank, type BriefSection } from "../db/job-queries.js";
import { childLogger } from "./../infra/logger.js";
import type { JobApplication } from "../db/schema.js";

const log = childLogger({ module: "gateway:jobhunt-commands" });

/** Enough of the posting for a tailored draft; the full body can reach 20k chars. */
const POSTING_EXCERPT_CHARS = 6_000;

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

/** What to say when the number does not resolve. Never a silent no-op. */
export function unresolvedMessage(command: string, rank: number | null): string {
  if (rank === null) {
    return (
      `Usage: /${command} <number> — the number next to a row in the latest job brief.\n` +
      `Example: /${command} 1`
    );
  }
  return (
    `No row ${rank} in the latest brief's ${command === "draft" ? "DO TODAY" : "ONE QUESTION AWAY"} ` +
    `section.\n\nThe numbers come from the most recent brief only. Ask me for the job brief to ` +
    `get a current list.`
  );
}

/** The drafting instruction for a row that cleared every gate. */
export function draftInstruction(row: JobApplication): string {
  return (
    `Draft a tailored application for this role. Call read_cv FIRST and lead with the ` +
    `strongest matching technical signal. Do NOT send anything — produce the draft for me to read.\n\n` +
    `Company: ${row.company}\n` +
    `Role: ${row.title}\n` +
    `Permit basis: ${row.route}\n` +
    `${row.url ? `URL: ${row.url}\n` : ""}` +
    `Screening evidence: ${row.salary_evidence ?? "none recorded"}\n\n` +
    `Posting:\n${(row.description ?? "").slice(0, POSTING_EXCERPT_CHARS)}`
  );
}

/**
 * The question instruction for a flagged row.
 *
 * A FLAG means exactly one gate is unresolved, and the stored evidence says
 * which. The question must target THAT gate — a generic "tell me more about the
 * role" wastes the one message the founder gets to send.
 */
export function askInstruction(row: JobApplication): string {
  return (
    `Write ONE short, specific question to send this employer. It must resolve the ` +
    `unsettled gate below and nothing else — do not ask about the role in general. ` +
    `Do NOT send it; show me the draft.\n\n` +
    `Company: ${row.company}\n` +
    `Role: ${row.title}\n` +
    `Permit basis under consideration: ${row.route}\n` +
    `${row.url ? `URL: ${row.url}\n` : ""}` +
    `What is unresolved: ${row.salary_evidence ?? "none recorded"}`
  );
}

export interface JobhuntCommandDeps {
  /** The normal kernel turn — same path a typed message takes. */
  readonly runKernelText: (ctx: Context, text: string) => Promise<void>;
}

async function handleRowCommand(
  ctx: Context,
  command: "draft" | "ask",
  section: BriefSection,
  compose: (row: JobApplication) => string,
  deps: JobhuntCommandDeps,
): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage(command, null));
    return;
  }

  const row = await getApplicationByBriefRank(section, rank);
  if (!row) {
    await ctx.reply(unresolvedMessage(command, rank));
    return;
  }

  log.info({ command, rank, company: row.company, id: row.id }, "Brief row command resolved");
  await deps.runKernelText(ctx, compose(row));
}

/** `/draft N` — write the application for row N of DO TODAY. */
export async function handleDraft(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  await handleRowCommand(ctx, "draft", "do_today", draftInstruction, deps);
}

/** `/ask N` — write the one question that unblocks row N of ONE QUESTION AWAY. */
export async function handleAsk(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  await handleRowCommand(ctx, "ask", "ask", askInstruction, deps);
}
