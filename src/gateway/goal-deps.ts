/**
 * FounderOS — goals: the gateway's dependencies and its two small guards
 * ======================================================================
 * Everything the /goal commands and buttons reach for, as one object, so the handlers are tested with an
 * in-memory repository and a fake kernel and the real wiring is bound in one place. Every heavy import is
 * lazy: the transport file (telegram.ts) must not pull Postgres, GitHub or the kernel into the bot's
 * startup path, and a unit test of a handler must not either.
 */

import type { Context } from "grammy";
import { TENANT } from "../core/config.js";
import { appTimeZone } from "../core/time.js";
import { logger } from "../infra/logger.js";
import type { MetricDeps } from "../goals/metrics.js";
import type { GoalRepo } from "../goals/repo.js";
import { createFileSkipLedger, type SkipLedger } from "../goals/skipped.js";
import { listProfiles, resolveProfileToken } from "../tools/jobhunt/profile-config.js";

export interface GoalLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Which goals have a "Plan next step" run in flight, in this process.
 *
 * The kernel's per-chat lock QUEUES a second turn behind the first (it never refuses one), and grammY
 * handles updates strictly one at a time, so a second tap would be handled only after the first run had
 * finished and then run again. Refusing it needs its own record, and the handler must not wait for the
 * run for that record to mean anything.
 */
export class PlanGuard {
  private readonly running = new Set<string>();
  /** True when this goal was free and is now marked running; false when a run for it is already in flight. */
  tryStart(goalId: string): boolean {
    if (this.running.has(goalId)) return false;
    this.running.add(goalId);
    return true;
  }
  finish(goalId: string): void {
    this.running.delete(goalId);
  }
}

/** A picker message is acted on once. Checked and marked with no await in between, so a fast double tap cannot pass twice. */
export class PickerGuard {
  private readonly seen = new Map<number, number>();
  constructor(
    private readonly ttlMs: number = 30 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}
  claim(messageId: number): boolean {
    const now = this.clock();
    for (const [id, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(id);
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, now);
    return true;
  }
}

/** Repos owned by an employer. Goals on them are out of scope for v1 (the plan), so they are never offered as buttons. */
export const EMPLOYER_REPO_OWNERS: readonly string[] = ["oplifymessage"];

export interface GoalCommandDeps {
  readonly repo: () => Promise<GoalRepo>;
  readonly metrics: () => Promise<MetricDeps>;
  /** Runs one kernel turn on `text` in this chat: the existing runKernelText, with its lock, halt and budget gates. */
  readonly runKernelText: (ctx: Context, text: string) => Promise<void>;
  readonly now: () => Date;
  readonly timeZone: () => string;
  readonly tenant: string;
  /** Registered candidate profiles: ids for buttons, and the resolver `metric=applications_7d:tashi` uses. */
  readonly profiles: () => { readonly ids: readonly string[]; readonly resolve: (token: string) => string | null };
  /** Repos a repo metric may be offered for, before employer repos are filtered out. */
  readonly repoChoices: () => Promise<readonly string[]>;
  readonly skips: () => SkipLedger;
  readonly planGuard: PlanGuard;
  readonly pickerGuard: PickerGuard;
  readonly log: GoalLog;
}

export function defaultGoalDeps(): GoalCommandDeps {
  return {
    repo: async () => (await import("../goals/pg-repo.js")).createPgGoalRepo(),
    metrics: async () => (await import("../goals/metric-deps.js")).createRealMetricDeps(),
    runKernelText: async (ctx, text) => (await import("./kernel-run.js")).runKernelText(ctx, text),
    now: () => new Date(),
    timeZone: appTimeZone,
    tenant: TENANT,
    profiles: () => ({ ids: listProfiles().map((p) => p.id), resolve: resolveProfileToken }),
    repoChoices: async () => {
      const [{ DISPATCH_REPO_ALLOWLIST }, { listRegisteredDispatchRepos }] = await Promise.all([
        import("../tools/dispatch-repos.js"),
        import("../db/queries.js"),
      ]);
      return [...new Set([...DISPATCH_REPO_ALLOWLIST, ...(await listRegisteredDispatchRepos(TENANT))])];
    },
    skips: () => createFileSkipLedger(),
    planGuard: new PlanGuard(),
    pickerGuard: new PickerGuard(),
    log: logger.child({ module: "goal-commands" }),
  };
}
