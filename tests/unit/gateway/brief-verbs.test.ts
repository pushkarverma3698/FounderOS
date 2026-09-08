/**
 * Unit tests — B2/B3/B4: the three read verbs, and what each one asks for.
 *
 * `/jobs`, `/today` and `/fresh` are ONE handler over ONE ranked population.
 * They differ only in the slice they print, and the property worth testing is
 * exactly that: which scope each verb hands to `buildDailyBrief`, and that the
 * scope is stated on the message rather than left to be inferred.
 *
 * The one with state is `/fresh`. It is a delta against a per-candidate marker,
 * so it has two failure modes that a window-based verb cannot have:
 *
 *   · stamping the marker before the list is delivered — those rows are then
 *     "seen" forever and `/fresh` never shows them again, silently
 *   · letting the sweep write the marker — the sweep runs 48 times a day, and a
 *     marker it moved would make every `/fresh` behave as `/jobs`
 *
 * The first is tested here. The second is structural: `saveLaneHeartbeat` and
 * `recordFreshView` write disjoint column sets (job-heartbeat-queries.ts).
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { handleJobs, handleToday, handleFresh, type JobsViewDeps } from "../../../src/gateway/jobhunt-view.js";
import type { BriefScopePlan } from "../../../src/tools/jobhunt/brief-resolver.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

function fakeCtx(args = "") {
  const replies: string[] = [];
  const ctx = {
    match: args,
    reply: vi.fn(async (text: string) => {
      replies.push(text);
    }),
  } as unknown as Context;
  return { ctx, replies };
}

function deps(over: Partial<JobsViewDeps> = {}) {
  const seen: Array<{ profile: JobSearchProfile; scope: BriefScopePlan }> = [];
  const stamped: Array<{ profileId: string }> = [];
  const base: JobsViewDeps = {
    buildBrief: async (profile, scope) => {
      seen.push({ profile, scope });
      return "<b>brief</b>";
    },
    split: (text) => [text],
    lastFreshView: async () => null,
    recordFreshView: async (profileId) => {
      stamped.push({ profileId });
    },
    ...over,
  };
  return { deps: base, seen, stamped };
}

describe("B2 — /jobs asks for everything on file", () => {
  it("carries no age limit and says so", async () => {
    const { ctx } = fakeCtx("");
    const d = deps();
    await handleJobs(ctx, d.deps);
    expect(d.seen[0]?.scope.windowHours).toBeNull();
    expect(d.seen[0]?.scope.label).toBe("everything on file");
  });

  it("addresses the founder's own queue by default", async () => {
    const { ctx } = fakeCtx("");
    const d = deps();
    await handleJobs(ctx, d.deps);
    expect(d.seen[0]?.profile.id).toBe("pushkar-nl-tech");
  });

  it("honours a range argument and names it in the scope", async () => {
    const { ctx } = fakeCtx("wife 2d");
    const d = deps();
    await handleJobs(ctx, d.deps);
    expect(d.seen[0]?.profile.id).toBe("wife-nl-finance");
    expect(d.seen[0]?.scope.windowHours).toBe(48);
    expect(d.seen[0]?.scope.label).toBe("posted in the last 2 days");
  });

  it("refuses a mistyped candidate instead of answering for the wrong one", async () => {
    const { ctx, replies } = fakeCtx("wfie 2d");
    const d = deps();
    await handleJobs(ctx, d.deps);
    expect(d.seen).toHaveLength(0);
    expect(replies.join("\n")).toContain("wfie");
  });
});

describe("B3 — /today asks for the last 24h of publication", () => {
  it("fixes the window at 24h on the posted axis", async () => {
    const { ctx } = fakeCtx("");
    const d = deps();
    await handleToday(ctx, d.deps);
    expect(d.seen[0]?.scope.windowHours).toBe(24);
    expect(d.seen[0]?.scope.axis).toBe("posted");
    expect(d.seen[0]?.scope.label).toBe("posted in the last 24h");
  });

  it("works for the other candidate", async () => {
    const { ctx } = fakeCtx("wife");
    const d = deps();
    await handleToday(ctx, d.deps);
    expect(d.seen[0]?.profile.id).toBe("wife-nl-finance");
    expect(d.seen[0]?.scope.windowHours).toBe(24);
  });
});

describe("B4 — /fresh is a delta against the last time he looked", () => {
  it("asks on the found axis, from the stored marker", async () => {
    const marker = new Date("2026-09-08T16:30:00Z");
    const { ctx } = fakeCtx("");
    const d = deps({ lastFreshView: async () => marker });
    await handleFresh(ctx, d.deps);
    expect(d.seen[0]?.scope.axis).toBe("found");
    expect(d.seen[0]?.scope.since).toEqual(marker);
    expect(d.seen[0]?.scope.label).toContain("16:30");
  });

  it("shows everything the first time, and says that is why", async () => {
    const { ctx } = fakeCtx("");
    const d = deps({ lastFreshView: async () => null });
    await handleFresh(ctx, d.deps);
    expect(d.seen[0]?.scope.since).toBeUndefined();
    expect(d.seen[0]?.scope.label).toContain("have not run /fresh before");
  });

  it("stamps the marker only AFTER the list was delivered", async () => {
    const order: string[] = [];
    const { ctx } = fakeCtx("");
    const d = deps({
      buildBrief: async () => {
        order.push("built");
        return "brief";
      },
      recordFreshView: async () => {
        order.push("stamped");
      },
    });
    await handleFresh(ctx, d.deps);
    expect(order).toEqual(["built", "stamped"]);
  });

  it("does NOT stamp when the build failed — those rows are still unseen", async () => {
    // The silent-loss case. A marker written on a failed render would retire
    // rows the founder never saw, permanently and with no signal.
    const { ctx, replies } = fakeCtx("");
    const d = deps({
      buildBrief: async () => {
        throw new Error("db down");
      },
    });
    await handleFresh(ctx, d.deps);
    expect(d.stamped).toHaveLength(0);
    expect(replies.join("\n")).toContain("Couldn't build");
  });

  it("still delivers the list when the marker write fails", async () => {
    // The opposite direction, and it must fail the other way: a lost marker
    // repeats rows next time, which is visible and costs nothing.
    const { ctx, replies } = fakeCtx("");
    const d = deps({
      recordFreshView: async () => {
        throw new Error("write failed");
      },
    });
    await handleFresh(ctx, d.deps);
    expect(replies.join("\n")).toContain("brief");
  });

  it("scopes to the named candidate's own marker", async () => {
    const asked: string[] = [];
    const { ctx } = fakeCtx("tashi");
    const d = deps({
      lastFreshView: async (profileId) => {
        asked.push(profileId);
        return null;
      },
    });
    await handleFresh(ctx, d.deps);
    expect(asked).toEqual(["wife-nl-finance"]);
    expect(d.stamped.map((s) => s.profileId)).toEqual(["wife-nl-finance"]);
  });
});

describe("B2–B4 — none of the three ever goes quiet", () => {
  it.each([
    ["jobs", handleJobs],
    ["today", handleToday],
    ["fresh", handleFresh],
  ])("%s tells the founder it is working before it blocks", async (_name, handler) => {
    // The ranking verifies the top rows over the network. A command that says
    // nothing for twenty seconds is one he assumes failed and retries, which
    // runs the whole thing twice.
    const { ctx, replies } = fakeCtx("");
    await handler(ctx, deps().deps);
    expect(replies[0]).toMatch(/🔍/);
    expect(replies).toHaveLength(2);
  });
});
