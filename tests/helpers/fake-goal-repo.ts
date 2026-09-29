/**
 * In-memory GoalRepo for unit tests (CI has no Postgres).
 *
 * It is held to the same behavioural contract as the Postgres repository
 * (tests/helpers/goal-repo-contract.ts, run against both), so it is a faithful stand-in and not a mock.
 *
 * Two things a test can do that a database will not let it do cheaply:
 *   `before[method]`  runs before that method; throw from it to make the call fail
 *   `calls`           every method invoked, in order, to assert "never touched storage"
 * Every method body runs synchronously after its first await, so a claim is atomic exactly as the
 * single SQL statement is.
 */

import { randomUUID } from "node:crypto";
import type { ClaimSummary, FinalizeInput, GoalRepo, StatusChange } from "../../src/goals/repo.js";
import type { GoalRow, NewGoal, ReviewResult, ReviewRow } from "../../src/goals/types.js";

export type RepoMethod = keyof GoalRepo;

const key = (goalId: string, reviewDate: string): string => `${goalId}|${reviewDate}`;

export class InMemoryGoalRepo implements GoalRepo {
  readonly goals = new Map<string, GoalRow>();
  readonly reviews = new Map<string, ReviewRow>();
  /** Runs before the named method; throw to simulate that call failing. */
  before: Partial<Record<RepoMethod, () => void | Promise<void>>> = {};
  readonly calls: RepoMethod[] = [];

  constructor(private readonly newId: () => string = randomUUID) {}

  private async enter(method: RepoMethod): Promise<void> {
    this.calls.push(method);
    await this.before[method]?.();
  }

  async addGoal(tenant: string, goal: NewGoal, now: Date): Promise<GoalRow> {
    await this.enter("addGoal");
    const row: GoalRow = {
      id: this.newId(),
      tenant_id: tenant,
      title: goal.title,
      metric_key: goal.metric_key,
      metric_arg: goal.metric_arg,
      target: goal.target,
      baseline: goal.baseline,
      due_on: goal.due_on,
      status: "active",
      blocked_until: null,
      blocker: null,
      priority: goal.priority,
      manual_value: null,
      manual_value_at: null,
      created_at: now,
      updated_at: now,
    };
    this.goals.set(row.id, row);
    return row;
  }

  async listOpenGoals(tenant: string): Promise<GoalRow[]> {
    await this.enter("listOpenGoals");
    return [...this.goals.values()]
      .filter((g) => g.tenant_id === tenant && (g.status === "active" || g.status === "blocked"))
      .sort((a, b) => a.priority - b.priority || a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1));
  }

  async getGoal(tenant: string, id: string): Promise<GoalRow | null> {
    await this.enter("getGoal");
    const g = this.goals.get(id);
    return g && g.tenant_id === tenant ? g : null;
  }

  private patch(tenant: string, id: string, change: Partial<GoalRow>, now: Date): GoalRow | null {
    const g = this.goals.get(id);
    if (!g || g.tenant_id !== tenant) return null;
    const next: GoalRow = { ...g, ...change, updated_at: now };
    this.goals.set(id, next);
    return next;
  }

  async updateStatus(tenant: string, id: string, change: StatusChange, now: Date): Promise<GoalRow | null> {
    await this.enter("updateStatus");
    if (change.status === "blocked") {
      return this.patch(tenant, id, { status: "blocked", blocker: change.blocker, blocked_until: change.blockedUntil }, now);
    }
    return this.patch(tenant, id, change.status === "active" ? { status: "active", blocker: null, blocked_until: null } : { status: change.status }, now);
  }

  async recordManualValue(tenant: string, id: string, value: number, now: Date): Promise<GoalRow | null> {
    await this.enter("recordManualValue");
    return this.patch(tenant, id, { manual_value: value, manual_value_at: now }, now);
  }

  async claimReviews(tenant: string, goalIds: readonly string[], reviewDate: string, now: Date, leaseMs: number): Promise<ClaimSummary> {
    await this.enter("claimReviews");
    const cutoff = now.getTime() - leaseMs;
    const claimed: { goalId: string; attempts: number }[] = [];
    const alreadySent: string[] = [];
    const leased: { goalId: string; claimedAt: Date }[] = [];
    for (const goalId of [...new Set(goalIds)].sort()) {
      const goal = this.goals.get(goalId);
      if (!goal || goal.tenant_id !== tenant) continue;
      const existing = this.reviews.get(key(goalId, reviewDate));
      if (!existing) {
        this.reviews.set(key(goalId, reviewDate), {
          goal_id: goalId,
          review_date: reviewDate,
          value: null,
          evidence: "",
          pace: "unknown",
          error: null,
          claimed_at: now,
          sent_at: null,
          attempts: 1,
        });
        claimed.push({ goalId, attempts: 1 });
      } else if (existing.sent_at !== null) {
        alreadySent.push(goalId);
      } else if (existing.claimed_at.getTime() < cutoff) {
        this.reviews.set(key(goalId, reviewDate), { ...existing, claimed_at: now, attempts: existing.attempts + 1 });
        claimed.push({ goalId, attempts: existing.attempts + 1 });
      } else {
        leased.push({ goalId, claimedAt: existing.claimed_at });
      }
    }
    return { claimed, alreadySent, leased };
  }

  async saveReviewResults(reviewDate: string, results: readonly ReviewResult[]): Promise<void> {
    await this.enter("saveReviewResults");
    for (const r of results) {
      const row = this.reviews.get(key(r.goalId, reviewDate));
      if (row) this.reviews.set(key(r.goalId, reviewDate), { ...row, value: r.value, evidence: r.evidence, pace: r.pace, error: r.error });
    }
  }

  async finalizeReviews(input: FinalizeInput): Promise<void> {
    await this.enter("finalizeReviews");
    for (const goalId of input.goalIds) {
      const row = this.reviews.get(key(goalId, input.reviewDate));
      if (row && row.sent_at === null) this.reviews.set(key(goalId, input.reviewDate), { ...row, sent_at: input.sentAt });
    }
    for (const t of input.transitions) {
      const g = this.goals.get(t.goalId);
      if (!g) continue;
      this.goals.set(t.goalId, {
        ...g,
        status: t.to,
        ...(t.to === "active" ? { blocker: null, blocked_until: null } : {}),
        updated_at: input.sentAt,
      });
    }
  }

  async hasSentReview(tenant: string, reviewDate: string): Promise<boolean> {
    await this.enter("hasSentReview");
    return [...this.reviews.values()].some(
      (r) => r.review_date === reviewDate && r.sent_at !== null && this.goals.get(r.goal_id)?.tenant_id === tenant,
    );
  }

  async recentReviews(goalId: string, limit: number): Promise<ReviewRow[]> {
    await this.enter("recentReviews");
    return [...this.reviews.values()]
      .filter((r) => r.goal_id === goalId && (r.evidence !== "" || r.error !== null))
      .sort((a, b) => (a.review_date < b.review_date ? 1 : -1))
      .slice(0, limit);
  }
}
