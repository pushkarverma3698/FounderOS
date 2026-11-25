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

  async function acquire(): Promise<void> {
    const at = Math.max(now(), nextAt, cooldownUntil);
    if (at > budgetEnd) throw new PacingBudgetError();
    nextAt = at + gap;
    for (let wait = at - now(); wait > 0; wait = Math.max(at, cooldownUntil) - now()) {
      await sleep(wait);
      if (Math.max(at, cooldownUntil) > budgetEnd) throw new PacingBudgetError();
    }
  }

  function limited(retryAfterMs: number | undefined): void {
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
      budgetEnd = opts.budgetMs === undefined ? Infinity : now() + opts.budgetMs;
    },
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

/** Workday gets extra attempts: the gate spaces them, so a retry is cheap and likely to land. */
export function attemptsFor(ats: FreeAts, base: number): number {
  return ats === "workday" ? base + 2 : base;
}
