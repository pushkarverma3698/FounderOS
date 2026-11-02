/**
 * Apply session: state, runner hook, per-row lock, answer bookkeeping
 * ====================================================================
 * The state behind `/apply`, split from apply-flow.ts (the card and the verdict) to keep both files
 * small. Holds:
 *  - the in-memory session per chat and per row (the jobs bot and the answer page share one process);
 *  - the sender abstraction: the Telegram context for replies, the bot API for a re-fill started from
 *    the answer page (an HTTP request has no Telegram context);
 *  - one lock per application row, shared by the Telegram path and the page;
 *  - the re-ask guard: `partitionStuck` splits what the form still shows unfilled into questions still
 *    to ask, questions answered this session that the form would not take, and questions skipped.
 */

import { InlineKeyboard, type Context } from "grammy";
import { childLogger } from "../infra/logger.js";
import { sendMessageTo } from "../infra/telegram-send.js";
import { deleteApplySnapshot, loadApplySnapshot, saveApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { normalizeQuestionKey } from "../tools/jobhunt/candidate-dossier.js";
import type { UnansweredQuestion } from "../tools/jobhunt/form-brain.js";
import { prepareApplicationForm, submitApplicationForm } from "../tools/jobhunt/form-runner.js";
import { releaseHeld } from "../tools/jobhunt/held-submit.js";
import { resolveApplyCoverLetter, type ApplyCoverLetter } from "./apply-cover-letter.js";

const log = childLogger({ module: "gateway:apply-session" });
const LOCK_STALE_MS = 10 * 60_000;
const HTML_OPTS = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };


export interface ApplySender {
  text(html: string, keyboard?: InlineKeyboard): Promise<void>;
}

export interface AnsweredEntry {
  readonly label: string;
  readonly answer: string;
}

export interface StuckQuestion {
  readonly question: UnansweredQuestion;
  readonly answer: string;
}

export interface PendingApplySession {
  readonly rowId: string;
  readonly chatId: string;
  readonly profileId: string;
  readonly candidateName: string;
  readonly company: string;
  readonly title: string;
  readonly targetUrl: string;
  readonly resumePdfPath: string;
  /** Attached to the form and to Submit; absent when none could be produced (`coverLetterNote` says why). */
  readonly coverLetter?: ApplyCoverLetter;
  readonly coverLetterNote?: string;
  /** Still to ask in Telegram: unfilled, and neither answered nor skipped in this session. */
  readonly unanswered: readonly UnansweredQuestion[];
  /** Answered in this session but the form still shows them unfilled (from the last prepare run). */
  readonly stuck: readonly StuckQuestion[];
  /** Every answer given this session (Telegram or page), in order. */
  readonly answered: AnsweredEntry[];
  /** Questions the founder skipped that the form still shows unfilled. */
  readonly skipped: UnansweredQuestion[];
  questionIndex: number;
  /** Minted per card run and carried in its buttons, so a tap on a superseded card is refused. */
  readonly cardStamp?: string;
}

export type SessionBase = Pick<
  PendingApplySession,
  "rowId" | "chatId" | "profileId" | "candidateName" | "company" | "title" | "targetUrl" | "resumePdfPath" | "coverLetter" | "coverLetterNote"
>;

export function newSession(base: SessionBase, answered: AnsweredEntry[] = []): PendingApplySession {
  return { ...base, unanswered: [], stuck: [], answered, skipped: [], questionIndex: 0 };
}

// ── card stamps ─────────────────────────────────────────────────────────────────────────────────

let stampSeq = Date.now();
/** Unique per card run, also across restarts (seeded from the clock); 8 base36 chars keeps buttons within 64 bytes. */
export const mintCardStamp = (): string => (stampSeq++).toString(36);
/** Callback suffix for Submit / Cancel buttons on this session's card. */
export const cardTag = (s?: PendingApplySession): string => (s?.cardStamp ? `:${s.cardStamp}` : "");
/** Callback suffix for the current question's answer buttons: also stale once the next question is asked. */
export const questionTag = (s?: PendingApplySession): string => (s?.cardStamp ? `:${s.cardStamp}.${s.questionIndex}` : "");

/**
 * True when a tap carries a stamp that is not the row's current card. Unstamped taps (cards sent before this
 * change) and taps with no live session (after a restart) are judged by the existing guards instead.
 */
export function isStaleTap(rowId: string, kind: "q" | "s" | "k", stamp: string | undefined): boolean {
  const session = sessionsByRow.get(rowId);
  if (!stamp || !session?.cardStamp) return false;
  return `:${stamp}` !== (kind === "q" ? questionTag(session) : cardTag(session));
}

export function ctxSender(ctx: Context): ApplySender {
  return {
    text: async (html, keyboard) => {
      await ctx.reply(html, { ...HTML_OPTS, ...(keyboard ? { reply_markup: keyboard } : {}) });
    },
  };
}

export function botSender(chatId: string): ApplySender {
  return {
    text: (html, keyboard) => sendMessageTo(chatId, html, { ...HTML_OPTS, ...(keyboard ? { reply_markup: keyboard } : {}) }),
  };
}

// ── sessions, runner, lock ──────────────────────────────────────────────────────────────────────

const sessionsByChat = new Map<string, PendingApplySession>();
const sessionsByRow = new Map<string, PendingApplySession>();
/** What holds a row's lock: the Telegram prepare/fill, a re-fill from the page, or a Submit (either surface). */
export type LockPhase = "prepare" | "refill" | "submit";
const locks = new Map<string, { readonly at: number; readonly phase: LockPhase }>();
/**
 * How the last Submit or Cancel on a row ended, kept in memory for the status route. Confirmed and cancelled
 * delete the snapshot, so the status route would 404 on the very answer the page is polling for; "failed" keeps
 * the reason of a send that did not go out. The profile id is what lets the route authorize after the snapshot is gone.
 */
export type OutcomeState = "submitting" | "confirmed" | "cancelled" | "failed";
export interface ApplyOutcome {
  readonly state: OutcomeState;
  readonly profileId: string;
  readonly detail: string;
}
const outcomes = new Map<string, ApplyOutcome>();
export const outcomeFor = (rowId: string): ApplyOutcome | undefined => outcomes.get(rowId);
export const recordOutcome = (rowId: string, profileId: string, state: OutcomeState, detail: string): void =>
  void outcomes.set(rowId, { state, profileId, detail });
export const clearOutcome = (rowId: string): void => void outcomes.delete(rowId);
/**
 * Rows whose Submit was clicked with no confirmation back. grammY runs updates one at a time, so a double tap
 * arrives after the first send has finished and released the lock; this refuses it until the form is reopened.
 */
const unconfirmedClicks = new Map<string, Date>();
const unconfirmedEvidence = new Map<string, string>();

export const sessionForChat = (chatId: string): PendingApplySession | undefined => sessionsByChat.get(chatId);
export const sessionForRow = (rowId: string): PendingApplySession | undefined => sessionsByRow.get(rowId);

export function setSession(session: PendingApplySession): void {
  sessionsByChat.set(session.chatId, session);
  sessionsByRow.set(session.rowId, session);
}

/** Ends the session for a row and deletes its snapshot, so the answer link dies with the session. */
export function endSession(rowId: string, root?: string): void {
  const session = sessionsByRow.get(rowId);
  if (session && sessionsByChat.get(session.chatId)?.rowId === rowId) sessionsByChat.delete(session.chatId);
  sessionsByRow.delete(rowId);
  void releaseHeld(rowId); // a form held for the emailed code closes with the session
  try {
    deleteApplySnapshot(rowId, root);
  } catch (err) {
    log.warn({ rowId, err: (err as Error).message }, "apply snapshot delete failed");
  }
}

export interface AutoApplyRunnerDeps {
  readonly prepare: typeof prepareApplicationForm;
  readonly submit: typeof submitApplicationForm;
  readonly coverLetter: typeof resolveApplyCoverLetter;
}

const REAL_RUNNER: AutoApplyRunnerDeps = { prepare: prepareApplicationForm, submit: submitApplicationForm, coverLetter: resolveApplyCoverLetter };
let runnerDeps: AutoApplyRunnerDeps = REAL_RUNNER;

export const getRunnerDeps = (): AutoApplyRunnerDeps => runnerDeps;

export function setAutoApplyRunnerForTests(override?: Partial<AutoApplyRunnerDeps>): void {
  runnerDeps = {
    prepare: override?.prepare ?? REAL_RUNNER.prepare,
    submit: override?.submit ?? REAL_RUNNER.submit,
    coverLetter: override?.coverLetter ?? REAL_RUNNER.coverLetter,
  };
}

export function clearAutoApplySessionsForTests(): void {
  sessionsByChat.clear();
  sessionsByRow.clear();
  locks.clear();
  unconfirmedClicks.clear();
  unconfirmedEvidence.clear();
  outcomes.clear();
}

/** When Submit was last clicked with no confirmation: memory first, else the snapshot (it survives a restart). */
export function unconfirmedClickAt(rowId: string): Date | undefined {
  const mem = unconfirmedClicks.get(rowId);
  if (mem) return mem;
  const at = loadApplySnapshot(rowId)?.unconfirmedAt;
  return at === undefined ? undefined : new Date(at);
}

/** Why the last Submit click came back unconfirmed: memory first, else the snapshot. */
export function unconfirmedEvidenceFor(rowId: string): string | undefined {
  return unconfirmedEvidence.get(rowId) ?? loadApplySnapshot(rowId)?.unconfirmedEvidence;
}

function persistUnconfirmed(rowId: string, at: number | undefined, evidence?: string): void {
  try {
    const snap = loadApplySnapshot(rowId);
    if (!snap || (snap.unconfirmedAt === at && snap.unconfirmedEvidence === evidence)) return;
    const { unconfirmedAt: _drop, unconfirmedEvidence: _dropEvidence, ...rest } = snap;
    saveApplySnapshot(at === undefined ? rest : { ...rest, unconfirmedAt: at, ...(evidence ? { unconfirmedEvidence: evidence } : {}) });
  } catch (err) {
    // allow-failopen: the in-memory guard still holds for this process; only its survival across a restart is lost.
    log.warn({ rowId, err: (err as Error).message }, "could not persist the unconfirmed-submit guard");
  }
}

export function noteUnconfirmedClick(rowId: string, evidence?: string): void {
  const now = new Date();
  unconfirmedClicks.set(rowId, now);
  if (evidence) unconfirmedEvidence.set(rowId, evidence);
  persistUnconfirmed(rowId, now.getTime(), evidence);
}

export function forgetUnconfirmedClick(rowId: string): void {
  unconfirmedClicks.delete(rowId);
  unconfirmedEvidence.delete(rowId);
  persistUnconfirmed(rowId, undefined);
}

/**
 * One re-fill per application row at a time, across the Telegram path and the answer page. Returns a
 * release function (safe to call twice, and a no-op once the lock was taken over), or null while another
 * run holds it. A lock older than ten minutes belongs to a crashed run and is taken over.
 */
export function tryLockApply(rowId: string, nowMs: number = Date.now(), phase: LockPhase = "prepare"): (() => void) | null {
  const held = locks.get(rowId);
  if (held && nowMs - held.at < LOCK_STALE_MS) return null;
  const mine = { at: nowMs, phase };
  locks.set(rowId, mine);
  return () => {
    if (locks.get(rowId) === mine) locks.delete(rowId);
  };
}

/** What is running on a row right now, or null. */
export function lockPhase(rowId: string, nowMs: number = Date.now()): LockPhase | null {
  const held = locks.get(rowId);
  return held && nowMs - held.at < LOCK_STALE_MS ? held.phase : null;
}

export const LOCK_HELD_MESSAGE = "⏳ This form is already re-filling. The updated card arrives in about a minute; answer after it lands.";

/** `tryLockApply`, telling the founder when the form is already being re-filled. */
export async function acquireApplyLock(send: ApplySender, rowId: string): Promise<(() => void) | null> {
  const held = tryLockApply(rowId);
  if (!held) await send.text(LOCK_HELD_MESSAGE);
  return held;
}

// ── answers, skips, stuck questions ─────────────────────────────────────────────────────────────

export const keyOf = (label: string): string => normalizeQuestionKey(label);

/** Latest answer for a label wins. Mutates the shared list. */
export function rememberAnswer(session: PendingApplySession, label: string, answer: string): void {
  const at = session.answered.findIndex((a) => keyOf(a.label) === keyOf(label));
  if (at >= 0) session.answered.splice(at, 1);
  session.answered.push({ label, answer });
}

export function markSkipped(session: PendingApplySession, question: UnansweredQuestion): void {
  if (!session.skipped.some((s) => keyOf(s.label) === keyOf(question.label))) session.skipped.push(question);
}

export interface StuckPartition {
  readonly pending: UnansweredQuestion[];
  readonly stuck: StuckQuestion[];
  readonly skipped: UnansweredQuestion[];
}

/**
 * Splits what the form still shows unfilled. An answer given this session wins over a skip: that
 * question is `stuck` (the form would not take our answer) and is never asked again. A skipped one
 * stays skipped. Everything else is still `pending` for Telegram. Labels match on the normalised key.
 */
export function partitionStuck(
  unanswered: readonly UnansweredQuestion[],
  answered: readonly AnsweredEntry[],
  skipped: readonly UnansweredQuestion[],
): StuckPartition {
  const answers = new Map(answered.map((a) => [keyOf(a.label), a.answer] as const));
  const skips = new Set(skipped.map((q) => keyOf(q.label)));
  const out: StuckPartition = { pending: [], stuck: [], skipped: [] };
  for (const question of unanswered) {
    const key = keyOf(question.label);
    const answer = answers.get(key);
    if (answer !== undefined) out.stuck.push({ question, answer });
    else if (skips.has(key)) out.skipped.push(question);
    else out.pending.push(question);
  }
  return out;
}
