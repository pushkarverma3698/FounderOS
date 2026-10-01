/**
 * When the standup runs: the 09:00 cron in the app's timezone, the boot-time catch-up node-cron does not
 * give us (a deploy restart at 09:00 would otherwise skip the day), and the bounded retry that turns a
 * crash between claim and send into "the next run sends" without waiting a day.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSchedule = vi.hoisted(() => vi.fn());
vi.mock("node-cron", () => ({ default: { schedule: mockSchedule }, schedule: mockSchedule }));

import {
  RETRY_MAX_ATTEMPTS,
  RETRY_MIN_DELAY_MS,
  STANDUP_CRON,
  isWithinStandupWindow,
  runGoalStandupCatchUp,
  runStandupCatchUp,
  runStandupWithRetry,
  scheduleGoalStandup,
} from "../../../src/goals/standup-schedule.js";
import { CLAIM_LEASE_MS, type OutgoingMessage, type StandupDeps } from "../../../src/goals/standup.js";
import type { SkipLedger } from "../../../src/goals/skipped.js";
import { appTimeZone } from "../../../src/core/time.js";
import { InMemoryGoalRepo } from "../../helpers/fake-goal-repo.js";
import { newGoal } from "../../helpers/goal-repo-contract.js";
import { NINE_AM, TZ, makeMetricDeps } from "../../helpers/goal-fixtures.js";

const T = "t";
const utc = (iso: string): Date => new Date(iso);

function harness(nowIso = "2026-09-29T07:00:00Z", over: Partial<StandupDeps> = {}) {
  const repo = new InMemoryGoalRepo();
  const clock = { t: Date.parse(nowIso) };
  const sent: OutgoingMessage[] = [];
  const slept: number[] = [];
  const skipped: string[] = [];
  const skips: SkipLedger = { record: async (d) => void skipped.push(d), take: async () => [] };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state: { halt: object | null } = { halt: null };
  const deps: StandupDeps = {
    repo,
    metrics: makeMetricDeps(),
    tenant: T,
    timeZone: TZ,
    leaseMs: CLAIM_LEASE_MS,
    metricTimeoutMs: 100,
    sendTimeoutMs: 100,
    log,
    now: () => new Date(clock.t),
    readHalt: async () => state.halt,
    skips,
    send: async (m) => void sent.push(m),
    ...over,
  };
  // A sleep that only moves the clock: the test never waits, and the lease really does expire.
  const retry = { sleep: async (ms: number) => void (slept.push(ms), (clock.t += ms)) };
  const goal = () => repo.addGoal(T, newGoal({ title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", due_on: "2026-10-31" }), new Date("2026-09-01T08:00:00Z"));
  return { repo, clock, sent, slept, skipped, log, deps, retry, state, goal };
}

beforeEach(() => mockSchedule.mockClear());

describe("the cron", () => {
  it("is 09:00, registered with the APP timezone, and nothing else about it is a guess", () => {
    expect(STANDUP_CRON).toBe("0 9 * * *");
    scheduleGoalStandup({ makeDeps: async () => harness().deps });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const [expression, callback, options] = mockSchedule.mock.calls[0]!;
    expect(expression).toBe("0 9 * * *");
    expect(typeof callback).toBe("function");
    expect(options).toEqual({ timezone: appTimeZone() });
  });

  it("runs the same idempotent function when it fires, and a second fire sends nothing new", async () => {
    const h = harness();
    await h.goal();
    const { tick } = scheduleGoalStandup({ makeDeps: async () => h.deps, retry: h.retry });
    const first = await tick();
    const second = await tick();
    expect(first.kind).toBe("sent");
    expect(second.kind).toBe("already-sent");
    expect(h.sent).toHaveLength(1);
  });

  it("leaves every other cron in startScheduler untouched: only the standup passes a timezone", async () => {
    const { startScheduler } = await import("../../../src/infra/scheduler.js");
    startScheduler();
    const withZone = mockSchedule.mock.calls.filter((c) => c[2] !== undefined);
    expect(withZone).toHaveLength(1);
    expect(withZone[0]![0]).toBe("0 9 * * *");
    expect(withZone[0]![2]).toEqual({ timezone: appTimeZone() });
    for (const call of mockSchedule.mock.calls.filter((c) => c[2] === undefined)) expect(call).toHaveLength(2);
    // The stale-approval reminder shares the 09:00 expression; it is still registered, without options.
    expect(mockSchedule.mock.calls.filter((c) => c[0] === "0 9 * * *")).toHaveLength(3);
  });
});

describe("isWithinStandupWindow — the boot catch-up's 'is it due' question", () => {
  it("opens at 09:00 local and closes at 21:00 local, in the app timezone, not UTC", () => {
    expect(isWithinStandupWindow(utc("2026-09-29T06:59:59Z"), TZ)).toBe(false); // 08:59:59 CEST
    expect(isWithinStandupWindow(utc("2026-09-29T07:00:00Z"), TZ)).toBe(true); // 09:00 CEST
    expect(isWithinStandupWindow(utc("2026-09-29T18:59:59Z"), TZ)).toBe(true); // 20:59:59 CEST
    expect(isWithinStandupWindow(utc("2026-09-29T19:00:00Z"), TZ)).toBe(false); // 21:00 CEST
  });

  it("follows the zone: 09:00 in Kolkata is 03:30 UTC", () => {
    expect(isWithinStandupWindow(utc("2026-09-29T03:29:00Z"), "Asia/Kolkata")).toBe(false);
    expect(isWithinStandupWindow(utc("2026-09-29T03:30:00Z"), "Asia/Kolkata")).toBe(true);
  });
});

describe("boot catch-up: a restart at 09:00:30 must not skip the day", () => {
  it("runs the standup once at boot when it is after 09:00 and nothing was sent today", async () => {
    const h = harness("2026-09-29T07:00:30Z");
    await h.goal();
    const out = await runStandupCatchUp(h.deps, h.retry);
    expect(out).toMatchObject({ kind: "ran", result: { kind: "sent" } });
    expect(h.sent).toHaveLength(1);
  });

  it("fires ONCE: a second boot the same day sends nothing", async () => {
    const h = harness("2026-09-29T07:00:30Z");
    await h.goal();
    await runStandupCatchUp(h.deps, h.retry);
    const again = await runStandupCatchUp(h.deps, h.retry);
    expect(again).toEqual({ kind: "not-due", reason: "already-sent" });
    expect(h.sent).toHaveLength(1);
  });

  it("does nothing when the cron already sent today's standup, and reads no metric", async () => {
    const h = harness("2026-09-29T07:00:00Z");
    await h.goal();
    await runStandupWithRetry(h.deps, h.retry);
    const metrics = h.deps.metrics as ReturnType<typeof makeMetricDeps>;
    metrics.countApplications.mockClear();
    h.clock.t += 60_000; // the restart, a minute later
    expect(await runStandupCatchUp(h.deps, h.retry)).toEqual({ kind: "not-due", reason: "already-sent" });
    expect(metrics.countApplications).not.toHaveBeenCalled();
  });

  it("does nothing before 09:00 local: the cron will fire", async () => {
    const h = harness("2026-09-29T06:30:00Z"); // 08:30 CEST
    await h.goal();
    expect(await runStandupCatchUp(h.deps, h.retry)).toEqual({ kind: "not-due", reason: "outside-window" });
    expect(h.sent).toEqual([]);
    expect(h.repo.calls).not.toContain("claimReviews");
  });

  it("does nothing after 21:00 local: a standup at night is noise, and tomorrow's is coming", async () => {
    const h = harness("2026-09-29T19:30:00Z"); // 21:30 CEST
    await h.goal();
    expect(await runStandupCatchUp(h.deps, h.retry)).toEqual({ kind: "not-due", reason: "outside-window" });
    expect(h.sent).toEqual([]);
  });

  it("uses the LOCAL date: 23:30 UTC is 01:30 tomorrow in Amsterdam, before the window, not the evening of the same day", async () => {
    const h = harness("2026-09-29T23:30:00Z");
    await h.goal();
    expect(await runStandupCatchUp(h.deps, h.retry)).toEqual({ kind: "not-due", reason: "outside-window" });
  });

  it("records a skipped day and sends nothing when the restart happens during a halt", async () => {
    const h = harness("2026-09-29T07:00:30Z");
    await h.goal();
    h.state.halt = { reason: "founder /halt" };
    const out = await runStandupCatchUp(h.deps, h.retry);
    expect(out).toMatchObject({ kind: "ran", result: { kind: "halted", date: "2026-09-29" } });
    expect(h.skipped).toEqual(["2026-09-29"]);
    expect(h.sent).toEqual([]);
  });

  it("waits out a live lease and then sends: the crash-and-fast-restart case, with no restart needed after it", async () => {
    const h = harness("2026-09-29T07:00:00Z");
    await h.goal();
    // The process that claimed the row died before sending.
    h.repo.before.saveReviewResults = () => new Promise(() => undefined);
    void runStandupWithRetry(h.deps, { sleep: async () => undefined });
    await vi.waitFor(() => expect(h.repo.calls).toContain("saveReviewResults"));
    h.repo.before.saveReviewResults = undefined;

    h.clock.t += 5_000; // systemd restarts it 5 seconds later
    const out = await runStandupCatchUp(h.deps, h.retry);

    expect(out).toMatchObject({ kind: "ran", result: { kind: "sent" } });
    expect(h.sent).toHaveLength(1);
    expect(h.slept).toHaveLength(1);
    expect(h.slept[0]).toBeGreaterThan(CLAIM_LEASE_MS - 5_000 - 1);
  });
});

describe("runStandupWithRetry — bounded, and loud when it gives up", () => {
  it("returns immediately for an outcome nothing can improve, without sleeping", async () => {
    const h = harness();
    expect((await runStandupWithRetry(h.deps, h.retry)).kind).toBe("nothing-due");
    await h.goal();
    expect((await runStandupWithRetry(h.deps, h.retry)).kind).toBe("sent");
    expect((await runStandupWithRetry(h.deps, h.retry)).kind).toBe("already-sent");
    expect(h.slept).toEqual([]);
  });

  it("retries a failed send after the lease and delivers on the next attempt, sending each goal once", async () => {
    const h = harness();
    await h.goal();
    let calls = 0;
    const flaky: StandupDeps["send"] = async (m) => {
      calls += 1;
      if (calls === 1) throw new Error("Bad Gateway");
      h.sent.push(m);
    };
    const out = await runStandupWithRetry({ ...h.deps, send: flaky }, h.retry);
    expect(out.kind).toBe("sent");
    expect(h.sent).toHaveLength(1);
    expect(h.slept).toEqual([CLAIM_LEASE_MS + 1000]);
  });

  it("retries an unexpected exception (a database that is down) after a short pause", async () => {
    const h = harness();
    await h.goal();
    let armed = true;
    h.repo.before.listOpenGoals = () => {
      if (armed) {
        armed = false;
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }
    };
    const out = await runStandupWithRetry(h.deps, h.retry);
    expect(out.kind).toBe("sent");
    expect(h.slept).toEqual([RETRY_MIN_DELAY_MS]);
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ component: "goals-standup" }), expect.stringContaining("standup"));
  });

  it("gives up after the attempt limit, says so to the founder with the reason and the fix, and does not throw", async () => {
    const h = harness();
    await h.goal();
    const alerts: OutgoingMessage[] = [];
    const deadSend: StandupDeps["send"] = async (m) => {
      if (m.text.includes("could not be sent")) alerts.push(m);
      throw new Error("Bad Gateway");
    };
    const out = await runStandupWithRetry({ ...h.deps, send: deadSend }, h.retry);
    expect(out.kind).toBe("send-failed");
    expect(h.slept).toHaveLength(RETRY_MAX_ATTEMPTS - 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("Tue 29 Sep");
    expect(alerts[0]!.text).toContain("Bad Gateway");
    expect(alerts[0]!.text).toContain(`${RETRY_MAX_ATTEMPTS} times`);
    expect(alerts[0]!.text).toContain("pnpm goals:standup --now");
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ component: "goals-standup", attempts: RETRY_MAX_ATTEMPTS }), expect.stringContaining("gave up"));
  });

  it("reports a persistent exception as failed, after the same bounded number of attempts", async () => {
    const h = harness();
    await h.goal();
    h.repo.before.listOpenGoals = () => {
      throw new Error("relation agents.goals does not exist");
    };
    const out = await runStandupWithRetry(h.deps, h.retry);
    expect(out).toMatchObject({ kind: "failed" });
    expect(h.slept).toHaveLength(RETRY_MAX_ATTEMPTS - 1);
    expect(h.sent.some((m) => m.text.includes("could not be sent"))).toBe(true);
  });
});

describe("runGoalStandupCatchUp — what index.ts calls at boot", () => {
  it("never rejects, even when the dependencies cannot be built, and says why in the log", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      runGoalStandupCatchUp({
        makeDeps: async () => {
          throw new Error("DATABASE_URL is not set");
        },
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ component: "goals-standup" }), expect.stringContaining("catch-up"));
  });

  it("runs the catch-up with real wiring order: deps, window check, standup", async () => {
    const h = harness("2026-09-29T07:00:30Z");
    await h.goal();
    await runGoalStandupCatchUp({ makeDeps: async () => h.deps, retry: h.retry, log: h.log });
    expect(h.sent).toHaveLength(1);
    expect(NINE_AM.getTime()).toBeLessThan(h.clock.t);
  });
});
