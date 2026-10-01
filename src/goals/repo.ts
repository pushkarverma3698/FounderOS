/**
 * FounderOS — goals: the repository interface
 * ===========================================
 * Everything the standup and the /goal commands need from storage, as one interface. Two
 * implementations, held to ONE behavioural contract (tests/helpers/goal-repo-contract.ts):
 *   pg-repo.ts                        Postgres (production)
 *   tests/helpers/fake-goal-repo.ts   in memory (unit tests: CI has no Postgres)
 * so a unit test that passes against the fake says something about the real thing.
 *
 * Time is always a parameter (`now`), never read here: the claim's lease and every timestamp are
 * testable with a fixed clock. `numeric` columns are parsed to finite numbers at the boundary.
 */

import type { GoalRow, NewGoal, ReviewResult, ReviewRow } from "./types.js";

export type StatusChange =
  | { readonly status: "active" | "done" | "dropped" }
  | { readonly status: "blocked"; readonly blocker: string; readonly blockedUntil: Date | null };

/**
 * What happened to each goal of one `claimReviews` call. Every goal id that exists for the tenant is in
 * exactly one list; unknown ids are in none.
 */
export interface ClaimSummary {
  /** Taken by this call. `attempts` is 1 for a first claim and higher when an expired claim was retaken. */
  readonly claimed: readonly { readonly goalId: string; readonly attempts: number }[];
  /** The message reporting these was already delivered: never touched again. */
  readonly alreadySent: readonly string[];
  /** Claimed by another run whose lease has not expired: that run owns them. */
  readonly leased: readonly { readonly goalId: string; readonly claimedAt: Date }[];
}

export interface FinalizeInput {
  readonly reviewDate: string;
  readonly goalIds: readonly string[];
  readonly sentAt: Date;
  /** Status moves applied in the SAME transaction that marks the reviews sent, so "done" is announced exactly once. */
  readonly transitions: readonly { readonly goalId: string; readonly to: "done" | "active" }[];
}

export interface GoalRepo {
  addGoal(tenant: string, goal: NewGoal, now: Date): Promise<GoalRow>;
  /** Status active or blocked, ordered (priority, created_at, id): the order `/goal <n>` numbers. */
  listOpenGoals(tenant: string): Promise<GoalRow[]>;
  /** Any status: a done or dropped goal keeps its row. */
  getGoal(tenant: string, id: string): Promise<GoalRow | null>;
  /** Null when the goal does not exist for this tenant. Unblocking (`active`) clears blocker and blocked_until. */
  updateStatus(tenant: string, id: string, change: StatusChange, now: Date): Promise<GoalRow | null>;
  recordManualValue(tenant: string, id: string, value: number, now: Date): Promise<GoalRow | null>;

  /**
   * Phase one of the two-phase standup: take the day's review rows, ALL OR NOTHING under concurrency
   * (one atomic statement, rows in id order), so two runs that start together cannot each win half the
   * goals and send two messages. A row with `sent_at` NULL whose `claimed_at` is older than `leaseMs`
   * is retaken with `attempts` + 1: that is what makes a run that died after claiming recoverable.
   */
  claimReviews(
    tenant: string,
    goalIds: readonly string[],
    reviewDate: string,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimSummary>;
  /** Phase two: record what was computed, before anything is sent. */
  saveReviewResults(reviewDate: string, results: readonly ReviewResult[]): Promise<void>;
  /** Phase three: the message was delivered. Marks the rows sent and applies `transitions`, atomically. */
  finalizeReviews(input: FinalizeInput): Promise<void>;
  /** Has any goal of this tenant a SENT review for this local date? (The boot catch-up's question.) */
  hasSentReview(tenant: string, reviewDate: string): Promise<boolean>;
  /** Newest first. Only rows a run actually computed (evidence or error recorded). */
  recentReviews(goalId: string, limit: number): Promise<ReviewRow[]>;
}
