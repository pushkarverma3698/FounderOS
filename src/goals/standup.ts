/**
 * FounderOS — goals: the daily standup (zero LLM)
 * ===============================================
 * The 09:00 message. Plain code reads real events, computes a pace, and writes one Telegram message;
 * no model is asked anything, so the standup costs $0 and still goes out when the daily budget is spent.
 * Only the "Plan next step" button a founder taps afterwards runs a kernel turn.
 *
 * EXACTLY ONCE AND CRASH-SAFE. The plan claimed each (goal, date) row up front and then computed and
 * sent, which loses the day silently if the process dies between the claim and the send: the row exists
 * and nothing was sent. So the work is three phases over a two-phase row:
 *
 *   1. CLAIM     one atomic statement takes the day's rows (repo.claimReviews). A row whose run died before
 *                sending is retaken once its lease has expired; a delivered row never is.
 *   2. COMPUTE   every goal's metric, in parallel, each with its own timeout. A failing source is a value
 *                ("metric unavailable: <reason>"), never a 0 and never a crash. Results are stored BEFORE
 *                anything is sent, so a failed send loses no evidence.
 *   3. SEND      one message at a time; each is marked sent (and its finished goals closed) in the same
 *                transaction as it is delivered, so a goal is announced done once.
 *
 * The one window that cannot be closed is a crash between Telegram accepting a message and the row being
 * marked sent: the retake re-sends it once. At-least-once is the honest trade against dropping the day.
 *
 * Deliberately NOT here: any import of a model, the kernel, the gateway or the budget guard. Those live
 * behind the "Plan next step" button (src/gateway/goal-commands.ts).
 */

import { evaluateGoals, toReviewResult, type GoalEvaluation } from "./evaluate.js";
import { localDateKey } from "./local-date.js";
import { renderStandup, type ButtonSpec, type RenderedMessage } from "./render.js";
import type { GoalRepo } from "./repo.js";
import type { MetricDeps } from "./metrics.js";
import type { SkipLedger } from "./skipped.js";

/** How long a claimed-but-unsent review row belongs to the run that took it. Comfortably above a run's real length. */
export const CLAIM_LEASE_MS = 5 * 60_000;
/** A message Telegram has not accepted in this long counts as failed. */
export const SEND_TIMEOUT_MS = 30_000;
/** Added to a lease's remaining time so a retry lands after it has expired, not on the boundary. */
const RETRY_SLACK_MS = 1_000;

export interface OutgoingMessage {
  readonly text: string;
  readonly keyboard: readonly (readonly ButtonSpec[])[];
}

export interface StandupLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface StandupDeps {
  readonly repo: GoalRepo;
  readonly metrics: MetricDeps;
  /** Sends ONE Telegram message. Throws when delivery fails. */
  readonly send: (message: OutgoingMessage) => Promise<void>;
  /** Non-null when FounderOS is halted. */
  readonly readHalt: () => Promise<unknown | null>;
  readonly skips: SkipLedger;
  readonly now: () => Date;
  readonly timeZone: string;
  readonly tenant: string;
  readonly leaseMs?: number;
  readonly metricTimeoutMs?: number;
  readonly sendTimeoutMs?: number;
  readonly log: StandupLog;
}

export type StandupOutcome =
  /** Delivered. `retryAfterMs` is set when another live run still held some goals: come back for them. */
  | { readonly kind: "sent"; readonly messages: number; readonly goals: number; readonly done: readonly string[]; readonly retryAfterMs: number | null }
  /** No open goals: nothing to say, and no empty message is sent. */
  | { readonly kind: "nothing-due" }
  | { readonly kind: "already-sent" }
  /** Another run holds today's rows and its lease has not expired. Retry after `retryAfterMs`. */
  | { readonly kind: "in-progress"; readonly retryAfterMs: number }
  | { readonly kind: "halted"; readonly date: string }
  | { readonly kind: "send-failed"; readonly error: string; readonly sentMessages: number; readonly retryAfterMs: number }
  | { readonly kind: "dry-run"; readonly messages: readonly RenderedMessage[] };

function withSendTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Telegram did not accept the message within ${Math.ceil(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** A delivery failure in words for the log and the alert: the message only, cut short, never the whole error object. */
export function describeSendError(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message.slice(0, 200) : "unknown error";
}

/** Which goals a delivered message finishes or un-blocks: applied in the same step that marks its rows sent. */
function transitionsFor(message: RenderedMessage, byId: ReadonlyMap<string, GoalEvaluation>): { goalId: string; to: "done" | "active" }[] {
  return message.goalIds.flatMap((goalId): { goalId: string; to: "done" | "active" }[] => {
    const e = byId.get(goalId);
    if (!e) return [];
    if (e.completed) return [{ goalId, to: "done" }];
    return e.unblockedNow ? [{ goalId, to: "active" }] : [];
  });
}

/**
 * Run the standup once. Idempotent: running it again (a double fire, a restart at 09:00:30, `--now`) sends
 * nothing that was already delivered. `dryRun` renders what would be sent without claiming, storing,
 * sending or marking anything, and previews even while halted.
 */
export async function runStandup(deps: StandupDeps, opts: { dryRun?: boolean } = {}): Promise<StandupOutcome> {
  const dryRun = opts.dryRun === true;
  const now = deps.now();
  const today = localDateKey(now, deps.timeZone);
  const leaseMs = deps.leaseMs ?? CLAIM_LEASE_MS;

  const open = await deps.repo.listOpenGoals(deps.tenant);
  if (open.length === 0) return { kind: "nothing-due" };

  if (!dryRun && (await deps.readHalt()) !== null) {
    await deps.skips.record(today);
    deps.log.warn({ date: today, goals: open.length }, "Goal standup skipped: FounderOS is halted. The founder is told which days at /resume.");
    return { kind: "halted", date: today };
  }

  // The numbers `/goal <n>` means: position in the whole ordered open list, whichever subset this run reports.
  const numbering = new Map(open.map((g, i) => [g.id, i + 1]));

  // Phase 1 — claim.
  let claimed = new Set(open.map((g) => g.id));
  let alreadySent = 0;
  let retryAfterMs: number | null = null;
  if (!dryRun) {
    const claim = await deps.repo.claimReviews(deps.tenant, [...claimed], today, now, leaseMs);
    claimed = new Set(claim.claimed.map((c) => c.goalId));
    alreadySent = claim.alreadySent.length;
    if (claim.leased.length > 0) {
      const heldUntil = Math.max(...claim.leased.map((l) => l.claimedAt.getTime() + leaseMs));
      retryAfterMs = Math.max(0, heldUntil - now.getTime()) + RETRY_SLACK_MS;
    }
  }
  if (claimed.size === 0) return retryAfterMs !== null ? { kind: "in-progress", retryAfterMs } : { kind: "already-sent" };

  // Phase 2 — compute, then store before anything is sent.
  const evaluations = await evaluateGoals(
    open.filter((g) => claimed.has(g.id)),
    numbering,
    deps.metrics,
    { now, timeZone: deps.timeZone, today, ...(deps.metricTimeoutMs !== undefined ? { timeoutMs: deps.metricTimeoutMs } : {}) },
  );
  if (!dryRun) await deps.repo.saveReviewResults(today, evaluations.map(toReviewResult));

  const messages = renderStandup(evaluations, { heading: "Standup", today, timeZone: deps.timeZone, mode: "standup", continued: alreadySent > 0 });
  if (dryRun) return { kind: "dry-run", messages };

  // Phase 3 — send one message at a time, marking its rows sent as it is delivered.
  const byId = new Map(evaluations.map((e) => [e.goal.id, e]));
  const done: string[] = [];
  let delivered = 0;
  for (const message of messages) {
    try {
      await withSendTimeout(deps.send({ text: message.text, keyboard: message.keyboard }), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS);
    } catch (err) {
      const error = describeSendError(err);
      deps.log.error(
        { component: "telegram-send", date: today, delivered, unsent: messages.length - delivered, error },
        "Goal standup: Telegram send failed. The undelivered goals are retried after the claim lease expires.",
      );
      return { kind: "send-failed", error, sentMessages: delivered, retryAfterMs: leaseMs + RETRY_SLACK_MS };
    }
    delivered += 1;
    const transitions = transitionsFor(message, byId);
    await deps.repo.finalizeReviews({ reviewDate: today, goalIds: message.goalIds, sentAt: deps.now(), transitions });
    for (const t of transitions) {
      const title = byId.get(t.goalId)?.goal.title;
      if (t.to === "done" && title !== undefined) done.push(title);
    }
  }
  deps.log.info({ date: today, messages: delivered, goals: evaluations.length, done: done.length }, "Goal standup sent");
  return { kind: "sent", messages: delivered, goals: evaluations.length, done, retryAfterMs };
}
