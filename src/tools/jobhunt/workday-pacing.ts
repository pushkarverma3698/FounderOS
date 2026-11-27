/**
 * Workday request pacing — one shared gate for every Workday board fetch.
 *
 * WHY (issue #1377): from 2026-11-16 Workday answered HTTP 429 to ~350 of ~390 boards every
 * sweep. A per-board stagger plus 4 workers does not bound the request rate: each board pages
 * up to 5 times, and paging happens inside a worker with no spacing. Workday limits the caller
 * IP across all tenants, so the gate is global to Workday rather than per host.
 *
 * Behaviour: request STARTS are spaced `gapMs` apart. A 429 opens a cooldown (Retry-After when
 * given) that holds every Workday request, and doubles the gap up to `maxGapMs`; successes
 * shrink it back toward the base. Escalation happens once per cooldown, so four in-flight 429s
 * do not quadruple the gap.
 */
import { HttpStatusError } from "./free-ats-transport.js";
import type { FreeAts } from "./free-boards.js";

/** Thrown (never retried) when a request's turn would start past the sweep's pacing budget. */
export class PacingBudgetError extends Error {
  constructor() {
    super("Workday pacing budget spent");
    this.name = "PacingBudgetError";
  }
}

/** Message of the error a tripped gate throws; the sweep counts these boards as deferred, not failed. */
export const WORKDAY_PAUSED_MSG = "Workday paused for this sweep after a 429";

/** Thrown (never retried) once a 429 has ended Workday for the current sweep (#1387). */
export class WorkdayPausedError extends Error {
  constructor() {
    super(WORKDAY_PAUSED_MSG);
    this.name = "WorkdayPausedError";
  }
}

export interface RequestGateOptions {
  /** Time from sweep start after which no new request may start. Counted from `reset()`. */
  readonly budgetMs?: number;
  readonly baseGapMs: number;
  readonly maxGapMs: number;
  readonly maxCooldownMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RequestGate {
  /** Run `fn` once it is this caller's turn; feeds the outcome back into the pacing. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Start a sweep: base gap, no cooldown, budget counted from now. */
  reset(): void;
  /** True once a 429 ended Workday for this sweep. */
  tripped(): boolean;
  /** Current spacing, for tests and logs. */
  gapMs(): number;
}

export function createRequestGate(opts: RequestGateOptions): RequestGate {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let gap = opts.baseGapMs;
  let nextAt = 0;
  let cooldownUntil = 0;
  let budgetEnd = Infinity; // unbounded until the first reset()
  let tripped = false;

  async function acquire(): Promise<void> {
    if (tripped) throw new WorkdayPausedError();
    const at = Math.max(now(), nextAt, cooldownUntil);
    if (at > budgetEnd) throw new PacingBudgetError();
    nextAt = at + gap;
    for (let wait = at - now(); wait > 0; wait = Math.max(at, cooldownUntil) - now()) {
      await sleep(wait);
      if (Math.max(at, cooldownUntil) > budgetEnd) throw new PacingBudgetError();
    }
  }

  function limited(retryAfterMs: number | undefined): void {
    tripped = true; // #1387: the first 429 ends Workday for this sweep; the backoff lives across sweeps
    const t = now();
    if (t < cooldownUntil) return; // already cooling down for this burst
    gap = Math.min(gap * 2, opts.maxGapMs);
    const cooldown = Math.min(retryAfterMs ?? gap * 4, opts.maxCooldownMs);
    cooldownUntil = t + cooldown;
    nextAt = Math.max(nextAt, cooldownUntil);
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        const result = await fn();
        gap = Math.max(opts.baseGapMs, Math.floor(gap * 0.95));
        return result;
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 429) limited(err.retryAfterMs);
        throw err;
      }
    },
    reset() {
      gap = opts.baseGapMs;
      nextAt = 0;
      cooldownUntil = 0;
      tripped = false;
      budgetEnd = opts.budgetMs === undefined ? Infinity : now() + opts.budgetMs;
    },
    tripped: () => tripped,
    gapMs: () => gap,
  };
}

/** ~3 request starts per second at rest; backs off to one per 4 s under 429s. */
export const workdayGate: RequestGate = createRequestGate({
  baseGapMs: 300,
  maxGapMs: 4_000,
  maxCooldownMs: 30_000,
  budgetMs: 15 * 60_000, // half the 30-minute sweep slot; later requests fail fast
});

/** Run a board request through its platform's gate (only Workday has one). */
export function paced<T>(ats: FreeAts, fn: () => Promise<T>, gate: RequestGate = workdayGate): Promise<T> {
  return ats === "workday" ? gate.run(fn) : fn();
}

/** Workday gets extra attempts for 5xx (a 429 is never retried: it trips the gate). */
export function attemptsFor(ats: FreeAts, base: number): number {
  return ats === "workday" ? base + 2 : base;
}

/** Boards fetched per sweep, round-robin: 48 sweeps a day cover ~390 boards many times over. */
export const WORKDAY_BOARDS_PER_SWEEP = 40;
const BACKOFF_FIRST_MS = 60 * 60_000;
const BACKOFF_MAX_MS = 12 * 60 * 60_000;

/** Kept across sweeps in this process: where the round-robin stopped, and the 429 backoff. */
let cursor = 0;
let backoffMs = 0;
let backoffUntil = 0;

export function resetWorkdayRotation(): void {
  cursor = 0;
  backoffMs = 0;
  backoffUntil = 0;
}

/** The boards to poll this sweep: non-Workday untouched, Workday capped, rotated, and none while backing off. */
export function selectWorkdayBoards<T extends { readonly ats: FreeAts }>(boards: readonly T[], t = Date.now()): T[] {
  const wd = boards.filter((b) => b.ats === "workday");
  const rest = boards.filter((b) => b.ats !== "workday");
  if (t < backoffUntil || wd.length === 0) return rest;
  const n = Math.min(WORKDAY_BOARDS_PER_SWEEP, wd.length);
  const start = cursor % wd.length;
  return [...rest, ...Array.from({ length: n }, (_, i) => wd[(start + i) % wd.length]!)];
}

/** After a sweep: advance the round-robin by the boards actually fetched; a 429 doubles the backoff, a clean sweep clears it. */
export function finishWorkdaySweep(fetched: number, wasTripped: boolean, t = Date.now()): void {
  cursor += fetched;
  if (wasTripped) {
    backoffMs = backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    backoffUntil = t + backoffMs;
  } else if (fetched > 0) {
    backoffMs = 0;
    backoffUntil = 0;
  }
}
