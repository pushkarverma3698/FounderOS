/**
 * The behavioural contract every GoalRepo must meet. Run against the in-memory fake in the unit suite
 * (tests/unit/goals/fake-repo-contract.test.ts) and against real Postgres in
 * tests/integration/goals-postgres.test.ts, so a unit test that passes on the fake says something about
 * the real thing — and a difference between the two shows up here, not in production.
 *
 * The two-phase claim is the heart of it: claim → compute → send → mark sent, where a claim with no
 * `sent_at` older than the lease is retaken. Each scenario below is one way that can go wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { GoalRepo } from "../../src/goals/repo.js";
import type { NewGoal } from "../../src/goals/types.js";

export interface RepoHarness {
  readonly repo: GoalRepo;
  /** A tenant id no other test uses, so a shared database needs no cleanup between tests. */
  readonly tenant: string;
  readonly cleanup?: () => Promise<void>;
}

export const T0 = new Date("2026-09-29T07:00:00.000Z");
export const at = (ms: number): Date => new Date(T0.getTime() + ms);
export const LEASE_MS = 5 * 60_000;
const DAY = "2026-09-29";
const NEXT_DAY = "2026-09-30";

export const newGoal = (over: Partial<NewGoal> = {}): NewGoal => ({
  title: "A goal",
  metric_key: "manual",
  metric_arg: null,
  target: 5,
  baseline: 0,
  due_on: null,
  priority: 100,
  ...over,
});

export function defineGoalRepoContract(label: string, makeHarness: () => Promise<RepoHarness>): void {
  describe(`GoalRepo contract: ${label}`, () => {
    let h: RepoHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });
    afterEach(async () => {
      await h.cleanup?.();
    });

    /** Three goals, added in order, ids returned in that order. */
    async function three(): Promise<string[]> {
      const ids: string[] = [];
      for (const [i, title] of ["A", "B", "C"].entries()) {
        ids.push((await h.repo.addGoal(h.tenant, newGoal({ title }), at(i * 1000))).id);
      }
      return ids;
    }

    describe("goals", () => {
      it("stores a goal and reads it back with the defaults the plan names and finite numbers", async () => {
        const added = await h.repo.addGoal(
          h.tenant,
          newGoal({ title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 2.5, baseline: 0.25, due_on: "2026-10-31", priority: 10 }),
          T0,
        );
        const got = await h.repo.getGoal(h.tenant, added.id);
        expect(got).toMatchObject({
          id: added.id,
          tenant_id: h.tenant,
          title: "Tashi applies",
          metric_key: "applications_7d",
          metric_arg: "wife-nl-finance",
          target: 2.5,
          baseline: 0.25,
          due_on: "2026-10-31",
          status: "active",
          priority: 10,
          blocker: null,
          blocked_until: null,
          manual_value: null,
          manual_value_at: null,
        });
        expect(got!.created_at.getTime()).toBe(T0.getTime());
        expect(got!.updated_at.getTime()).toBe(T0.getTime());
      });

      it("round-trips a tiny, a zero-baseline and a very large numeric as numbers, never strings or NaN", async () => {
        const tiny = await h.repo.addGoal(h.tenant, newGoal({ target: 0.000001 }), T0);
        const huge = await h.repo.addGoal(h.tenant, newGoal({ target: 1e15, baseline: 0 }), T0);
        expect((await h.repo.getGoal(h.tenant, tiny.id))!.target).toBe(0.000001);
        const big = (await h.repo.getGoal(h.tenant, huge.id))!;
        expect(big.target).toBe(1e15);
        expect(big.baseline).toBe(0);
        expect(typeof big.target).toBe("number");
      });

      it("does not show one tenant's goal to another", async () => {
        const g = await h.repo.addGoal(h.tenant, newGoal(), T0);
        expect(await h.repo.getGoal(`${h.tenant}-other`, g.id)).toBeNull();
        expect(await h.repo.listOpenGoals(`${h.tenant}-other`)).toEqual([]);
      });

      it("lists open goals by priority, then creation time — the order /goal <n> numbers", async () => {
        const a = await h.repo.addGoal(h.tenant, newGoal({ title: "A", priority: 100 }), at(0));
        const b = await h.repo.addGoal(h.tenant, newGoal({ title: "B", priority: 100 }), at(1000));
        const c = await h.repo.addGoal(h.tenant, newGoal({ title: "C", priority: 10 }), at(2000));
        expect((await h.repo.listOpenGoals(h.tenant)).map((g) => g.id)).toEqual([c.id, a.id, b.id]);
      });

      it("lists blocked goals as open, and drops done and dropped ones from the list without deleting them", async () => {
        const [a, b, c] = await three();
        await h.repo.updateStatus(h.tenant, a!, { status: "blocked", blocker: "waiting", blockedUntil: at(86_400_000) }, at(5000));
        await h.repo.updateStatus(h.tenant, b!, { status: "done" }, at(5000));
        await h.repo.updateStatus(h.tenant, c!, { status: "dropped" }, at(5000));
        const open = await h.repo.listOpenGoals(h.tenant);
        expect(open.map((g) => [g.id, g.status])).toEqual([[a, "blocked"]]);
        expect((await h.repo.getGoal(h.tenant, b!))!.status).toBe("done");
        expect((await h.repo.getGoal(h.tenant, c!))!.status).toBe("dropped");
      });
    });

    describe("status changes", () => {
      it("blocks with a reason and an end, and unblocks by clearing both", async () => {
        const g = await h.repo.addGoal(h.tenant, newGoal(), T0);
        const until = at(3 * 86_400_000);
        const blocked = await h.repo.updateStatus(h.tenant, g.id, { status: "blocked", blocker: "visa decision", blockedUntil: until }, at(1000));
        expect(blocked).toMatchObject({ status: "blocked", blocker: "visa decision" });
        expect(blocked!.blocked_until!.getTime()).toBe(until.getTime());
        expect(blocked!.updated_at.getTime()).toBe(at(1000).getTime());

        const back = await h.repo.updateStatus(h.tenant, g.id, { status: "active" }, at(2000));
        expect(back).toMatchObject({ status: "active", blocker: null, blocked_until: null });
      });

      it("can block with no end date", async () => {
        const g = await h.repo.addGoal(h.tenant, newGoal(), T0);
        const blocked = await h.repo.updateStatus(h.tenant, g.id, { status: "blocked", blocker: "waiting", blockedUntil: null }, at(1000));
        expect(blocked).toMatchObject({ status: "blocked", blocker: "waiting", blocked_until: null });
      });

      it("answers null and changes nothing for a goal of another tenant or one that does not exist", async () => {
        const g = await h.repo.addGoal(h.tenant, newGoal(), T0);
        expect(await h.repo.updateStatus(`${h.tenant}-other`, g.id, { status: "done" }, at(1000))).toBeNull();
        expect(await h.repo.updateStatus(h.tenant, "00000000-0000-4000-8000-000000000000", { status: "done" }, at(1000))).toBeNull();
        expect((await h.repo.getGoal(h.tenant, g.id))!.status).toBe("active");
      });
    });

    describe("manual values", () => {
      it("records a value with its date, keeps a reported 0 as 0 (not null), and overwrites on the next report", async () => {
        const g = await h.repo.addGoal(h.tenant, newGoal(), T0);
        const first = await h.repo.recordManualValue(h.tenant, g.id, 0, at(1000));
        expect(first).toMatchObject({ manual_value: 0 });
        expect(first!.manual_value_at!.getTime()).toBe(at(1000).getTime());
        const second = await h.repo.recordManualValue(h.tenant, g.id, 1234.5, at(2000));
        expect(second).toMatchObject({ manual_value: 1234.5 });
        expect(second!.manual_value_at!.getTime()).toBe(at(2000).getTime());
      });

      it("answers null for a goal of another tenant", async () => {
        const g = await h.repo.addGoal(h.tenant, newGoal(), T0);
        expect(await h.repo.recordManualValue(`${h.tenant}-other`, g.id, 5, at(1000))).toBeNull();
      });
    });

    describe("claimReviews — phase one of the two-phase standup", () => {
      it("claims every goal on the first call, attempt 1", async () => {
        const ids = await three();
        const out = await h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS);
        expect(out.claimed.map((c) => c.goalId).sort()).toEqual([...ids].sort());
        expect(out.claimed.every((c) => c.attempts === 1)).toBe(true);
        expect(out.alreadySent).toEqual([]);
        expect(out.leased).toEqual([]);
      });

      it("refuses a second claim inside the lease and says who holds it and since when", async () => {
        const ids = await three();
        await h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS);
        const again = await h.repo.claimReviews(h.tenant, ids, DAY, at(60_000), LEASE_MS);
        expect(again.claimed).toEqual([]);
        expect(again.leased.map((l) => l.goalId).sort()).toEqual([...ids].sort());
        expect(again.leased.every((l) => l.claimedAt.getTime() === at(0).getTime())).toBe(true);
      });

      it("keeps the claim through the last instant of the lease and retakes it one millisecond later (attempt 2)", async () => {
        const ids = await three();
        await h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS);
        const boundary = await h.repo.claimReviews(h.tenant, ids, DAY, at(LEASE_MS), LEASE_MS);
        expect(boundary.claimed).toEqual([]);
        const after = await h.repo.claimReviews(h.tenant, ids, DAY, at(LEASE_MS + 1), LEASE_MS);
        expect(after.claimed.map((c) => c.attempts)).toEqual([2, 2, 2]);
        expect(after.leased).toEqual([]);
      });

      it("never retakes a row whose message was delivered, however long ago", async () => {
        const ids = await three();
        await h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS);
        await h.repo.finalizeReviews({ reviewDate: DAY, goalIds: ids, sentAt: at(1000), transitions: [] });
        const later = await h.repo.claimReviews(h.tenant, ids, DAY, at(30 * 86_400_000), LEASE_MS);
        expect(later.claimed).toEqual([]);
        expect(later.leased).toEqual([]);
        expect([...later.alreadySent].sort()).toEqual([...ids].sort());
      });

      it("is all-or-nothing when two runs start together: one wins every goal, the other none", async () => {
        const ids = await three();
        const [x, y] = await Promise.all([
          h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS),
          h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS),
        ]);
        const counts = [x.claimed.length, y.claimed.length].sort();
        expect(counts).toEqual([0, 3]);
        const loser = x.claimed.length === 0 ? x : y;
        expect(loser.leased).toHaveLength(3);
      });

      it("keeps one local date independent of the next", async () => {
        const ids = await three();
        await h.repo.claimReviews(h.tenant, ids, DAY, at(0), LEASE_MS);
        const tomorrow = await h.repo.claimReviews(h.tenant, ids, NEXT_DAY, at(60_000), LEASE_MS);
        expect(tomorrow.claimed).toHaveLength(3);
      });

      it("after a partial delivery retakes only what was not delivered", async () => {
        const [a, b] = await three();
        await h.repo.claimReviews(h.tenant, [a!, b!], DAY, at(0), LEASE_MS);
        await h.repo.finalizeReviews({ reviewDate: DAY, goalIds: [a!], sentAt: at(1000), transitions: [] });
        const retry = await h.repo.claimReviews(h.tenant, [a!, b!], DAY, at(LEASE_MS + 1), LEASE_MS);
        expect(retry.claimed).toEqual([{ goalId: b, attempts: 2 }]);
        expect(retry.alreadySent).toEqual([a]);
      });

      it("claims a goal added after the first run in the same statement as the ones it retakes", async () => {
        const [a] = await three();
        await h.repo.claimReviews(h.tenant, [a!], DAY, at(0), LEASE_MS);
        const late = await h.repo.addGoal(h.tenant, newGoal({ title: "late" }), at(10_000));
        const retry = await h.repo.claimReviews(h.tenant, [a!, late.id], DAY, at(LEASE_MS + 1), LEASE_MS);
        expect(retry.claimed.map((c) => c.goalId).sort()).toEqual([a, late.id].sort());
      });

      it("ignores an unknown goal id and another tenant's goal, and tolerates a repeated id", async () => {
        const [a] = await three();
        const other = await h.repo.addGoal(`${h.tenant}-other`, newGoal(), T0);
        const out = await h.repo.claimReviews(h.tenant, [a!, a!, other.id, "00000000-0000-4000-8000-000000000000"], DAY, at(0), LEASE_MS);
        expect(out.claimed).toEqual([{ goalId: a, attempts: 1 }]);
        expect(out.alreadySent).toEqual([]);
        expect(out.leased).toEqual([]);
        expect(await h.repo.recentReviews(other.id, 5)).toEqual([]);
      });

      it("handles an empty list", async () => {
        expect(await h.repo.claimReviews(h.tenant, [], DAY, at(0), LEASE_MS)).toEqual({ claimed: [], alreadySent: [], leased: [] });
      });
    });

    describe("saveReviewResults and recentReviews — phase two", () => {
      it("stores the computed value, evidence, pace and error, and tells 0 from unavailable", async () => {
        const [a, b, c] = await three();
        await h.repo.claimReviews(h.tenant, [a!, b!, c!], DAY, at(0), LEASE_MS);
        await h.repo.saveReviewResults(DAY, [
          { goalId: a!, value: 3.5, evidence: "3 applications", pace: "behind", error: null },
          { goalId: b!, value: 0, evidence: "0 applications", pace: "behind", error: null },
          { goalId: c!, value: null, evidence: "", pace: "unknown", error: "GitHub rejected the token (HTTP 401)." },
        ]);
        const [ra] = await h.repo.recentReviews(a!, 5);
        const [rb] = await h.repo.recentReviews(b!, 5);
        const [rc] = await h.repo.recentReviews(c!, 5);
        expect(ra).toMatchObject({ goal_id: a, review_date: DAY, value: 3.5, evidence: "3 applications", pace: "behind", error: null, attempts: 1, sent_at: null });
        expect(ra!.claimed_at.getTime()).toBe(at(0).getTime());
        expect(rb!.value).toBe(0);
        expect(rc).toMatchObject({ value: null, pace: "unknown", error: "GitHub rejected the token (HTTP 401)." });
      });

      it("returns newest first, honours the limit, and leaves out a row nothing was computed for", async () => {
        const [a] = await three();
        for (const [i, day] of ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].entries()) {
          await h.repo.claimReviews(h.tenant, [a!], day, at(i * 1000), LEASE_MS);
          await h.repo.saveReviewResults(day, [{ goalId: a!, value: i, evidence: `${i} things`, pace: "on_track", error: null }]);
        }
        await h.repo.claimReviews(h.tenant, [a!], DAY, at(9000), LEASE_MS); // claimed, never computed
        const rows = await h.repo.recentReviews(a!, 3);
        expect(rows.map((r) => r.review_date)).toEqual(["2026-09-28", "2026-09-27", "2026-09-26"]);
      });
    });

    describe("finalizeReviews and hasSentReview — the message was delivered", () => {
      it("marks exactly the given goals sent, once: a second finalize does not move sent_at", async () => {
        const [a, b] = await three();
        await h.repo.claimReviews(h.tenant, [a!, b!], DAY, at(0), LEASE_MS);
        await h.repo.saveReviewResults(DAY, [
          { goalId: a!, value: 1, evidence: "1 x", pace: "behind", error: null },
          { goalId: b!, value: 1, evidence: "1 x", pace: "behind", error: null },
        ]);
        await h.repo.finalizeReviews({ reviewDate: DAY, goalIds: [a!], sentAt: at(1000), transitions: [] });
        await h.repo.finalizeReviews({ reviewDate: DAY, goalIds: [a!], sentAt: at(9000), transitions: [] });
        const [ra] = await h.repo.recentReviews(a!, 1);
        const [rb] = await h.repo.recentReviews(b!, 1);
        expect(ra!.sent_at!.getTime()).toBe(at(1000).getTime());
        expect(rb!.sent_at).toBeNull();
      });

      it("applies status transitions in the same step: a finished goal leaves the list, an unblocked one returns", async () => {
        const [a, b] = await three();
        await h.repo.updateStatus(h.tenant, b!, { status: "blocked", blocker: "x", blockedUntil: at(1000) }, at(500));
        await h.repo.claimReviews(h.tenant, [a!, b!], DAY, at(2000), LEASE_MS);
        await h.repo.finalizeReviews({
          reviewDate: DAY,
          goalIds: [a!, b!],
          sentAt: at(3000),
          transitions: [
            { goalId: a!, to: "done" },
            { goalId: b!, to: "active" },
          ],
        });
        expect((await h.repo.getGoal(h.tenant, a!))!.status).toBe("done");
        expect(await h.repo.getGoal(h.tenant, b!)).toMatchObject({ status: "active", blocker: null, blocked_until: null });
        expect((await h.repo.listOpenGoals(h.tenant)).map((g) => g.id)).not.toContain(a);
      });

      it("answers hasSentReview only for a delivered review of this tenant and date", async () => {
        const [a] = await three();
        expect(await h.repo.hasSentReview(h.tenant, DAY)).toBe(false);
        await h.repo.claimReviews(h.tenant, [a!], DAY, at(0), LEASE_MS);
        expect(await h.repo.hasSentReview(h.tenant, DAY)).toBe(false); // claimed is not sent
        await h.repo.finalizeReviews({ reviewDate: DAY, goalIds: [a!], sentAt: at(1000), transitions: [] });
        expect(await h.repo.hasSentReview(h.tenant, DAY)).toBe(true);
        expect(await h.repo.hasSentReview(h.tenant, NEXT_DAY)).toBe(false);
        expect(await h.repo.hasSentReview(`${h.tenant}-other`, DAY)).toBe(false);
      });
    });
  });
}
