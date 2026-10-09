/**
 * "What's running?" — the ops_state `background_jobs` scope (src/tools/background-jobs.ts).
 * ========================================================================================
 * The founder asked what the bot is running and got a hand-written paragraph that did not know about /review, the
 * models or the VPS jobs. The answer now comes from what the daemons report (~/.claude/*.effective, *.off, *.down)
 * and from the scheduler registry, so it cannot disagree with them.
 *
 * Shaped for a person reading a phone, not a log:
 *   - one `summary` line that leads with the result, or with what needs attention;
 *   - `attention` lists only what is off, paused, stale or unreadable, each with the next step;
 *   - the two systems he can act on come first; the built-in routines follow, one plain sentence each.
 */

import { describe, expect, it } from "vitest";
import { basename } from "node:path";
import { readBackgroundJobs, type BackgroundDeps } from "../../../src/tools/background-jobs.js";
import { SCHEDULED_ROUTINES } from "../../../src/infra/scheduler-registry.js";

const NOW = Date.UTC(2026, 9, 4, 14, 0, 0);
const sec = (ms: number): number => Math.floor(ms / 1000);

const FRESH_BRAIN = `written=${sec(NOW - 5 * 60_000)}\nengine=agy\nreviewers=claude-sonnet-5-5-medium gemini-3.1-pro-high\nmerge=1\n`;
const FRESH_DISPATCH = `written=${sec(NOW - 5 * 60_000)}\nagy_model=gemini-3.8-flash-medium\nclaude_model=sonnet\n`;

/** Files by basename ("pr-brain.off"); a value of Error is thrown when read. */
function deps(files: Record<string, string | Error>, engine: "agy" | "claude" = "agy"): BackgroundDeps {
  return {
    read: (file) => {
      const v = files[basename(file)];
      if (v === undefined) return null;
      if (v instanceof Error) throw v;
      return v;
    },
    now: () => NOW,
    engine: () => engine,
    deployed: () => DEPLOYED,
  };
}

const DEPLOYED = 'Deployed: fec3075 "fix(pr-brain): kill switch (#996)" (2026-10-07 08:42 UTC), process started 2026-10-07 09:50 UTC';

const HEALTHY = { "pr-brain.effective": FRESH_BRAIN, "agent-dispatch.effective": FRESH_DISPATCH };

const job = (view: ReturnType<typeof readBackgroundJobs>, name: string) => {
  const found = view.jobs.find((j) => j.name === name);
  if (!found) throw new Error(`no job called ${name}: ${view.jobs.map((j) => j.name).join(" | ")}`);
  return found;
};

describe("background_jobs — healthy", () => {
  const view = readBackgroundJobs(deps(HEALTHY));

  it("leads with the result and counts the routines", () => {
    expect(view.summary).toBe(`Everything is running: PR review ON, coding dispatch ON, ${SCHEDULED_ROUTINES.length} built-in routines.`);
    expect(view.attention).toEqual([]);
  });

  it("names the reviewers, and says a cleared PR is merged", () => {
    const review = job(view, "Automatic PR review");
    expect(review).toMatchObject({ kind: "daemon", state: "on", runs: "every 20 minutes", switch: "/review off" });
    expect(review.detail).toContain("claude-sonnet-5-5-medium, then gemini-3.1-pro-high");
    expect(review.detail).toContain("merges a PR it clears");
  });

  it("names the writer for the default engine and the other one", () => {
    const dispatch = job(view, "Coding dispatch");
    expect(dispatch).toMatchObject({ kind: "daemon", state: "on", runs: "every 15 minutes" });
    expect(dispatch.detail).toContain("Antigravity on gemini-3.8-flash-medium");
    expect(dispatch.detail).toContain("Claude Code on sonnet");
  });

  it("lists the two systems he can act on before the routines", () => {
    expect(view.jobs.slice(0, 2).map((j) => j.kind)).toEqual(["daemon", "daemon"]);
    expect(view.jobs.slice(2).every((j) => j.kind === "routine")).toBe(true);
  });

  it("gives each routine its schedule and a plain sentence", () => {
    const routines = view.jobs.filter((j) => j.kind === "routine");
    expect(routines).toHaveLength(SCHEDULED_ROUTINES.length);
    for (const r of routines) {
      expect(r.runs.length).toBeGreaterThan(0);
      expect(r.detail.length).toBeGreaterThan(10);
      expect(r.state).toBe("on");
    }
  });
});

describe("background_jobs — which commit is live", () => {
  it("carries the deployed line as its own field, whatever else is off", () => {
    expect(readBackgroundJobs(deps(HEALTHY)).deployed).toBe(DEPLOYED);
    expect(readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.off": "switched off\n" })).deployed).toBe(DEPLOYED);
    expect(readBackgroundJobs(deps({})).deployed).toBe(DEPLOYED);
  });

  it("leaves the summary and the attention list alone, so a known deploy is never an alarm", () => {
    const view = readBackgroundJobs(deps(HEALTHY));
    expect(view.summary).not.toContain("Deployed");
    expect(view.attention).toEqual([]);
  });
});

describe("background_jobs — the default engine decides which writer is named first", () => {
  it("claude", () => {
    const dispatch = job(readBackgroundJobs(deps(HEALTHY, "claude")), "Coding dispatch");
    expect(dispatch.detail.indexOf("Claude Code on sonnet")).toBeLessThan(dispatch.detail.indexOf("Antigravity"));
  });
});

describe("background_jobs — what needs attention comes first and says what to do", () => {
  it("review switched off", () => {
    const view = readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.off": "switched off\n" }));
    expect(job(view, "Automatic PR review").state).toBe("off");
    expect(job(view, "Automatic PR review").switch).toBe("/review on");
    expect(view.attention).toEqual(["PR review is OFF: agent PRs wait for you. /review on turns it back on."]);
    expect(view.summary.startsWith("1 thing needs attention")).toBe(true);
    expect(view.summary).toContain("PR review is OFF");
  });

  it("a paused daemon names why and since when", () => {
    const view = readBackgroundJobs(deps({ ...HEALTHY, "agent-dispatch.down": "auth\n2026-10-04 12:10 UTC\n" }));
    const dispatch = job(view, "Coding dispatch");
    expect(dispatch.state).toBe("paused");
    expect(dispatch.detail).toContain("auth");
    expect(dispatch.detail).toContain("2026-10-04 12:10 UTC");
    expect(view.attention).toHaveLength(1);
    expect(view.attention[0]).toContain("Coding dispatch is paused");
    expect(view.attention[0]).toContain("auth");
  });

  it("paused outranks off when both files are there", () => {
    const view = readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.off": "x", "pr-brain.down": "limit\n2026-10-04 11:00 UTC\n" }));
    expect(job(view, "Automatic PR review").state).toBe("paused");
  });

  it("a report older than two hours says the cron may have stopped", () => {
    const old = `written=${sec(NOW - 5 * 3_600_000)}\nengine=agy\nreviewers=model-a\nmerge=1\n`;
    const view = readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.effective": old }));
    const review = job(view, "Automatic PR review");
    expect(review.state).toBe("on");
    expect(review.detail).toContain("last reported 5 h ago");
    expect(view.attention).toEqual(["PR review last reported 5 h ago: its cron may have stopped."]);
  });

  it("a daemon that has never reported is not an alarm, and says when it will", () => {
    const view = readBackgroundJobs(deps({}));
    expect(job(view, "Automatic PR review").detail).toContain("not reported yet");
    expect(job(view, "Coding dispatch").detail).toContain("not reported yet");
    expect(view.attention).toEqual([]);
  });

  it("an unreadable report names the file and the reason instead of guessing", () => {
    const view = readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.effective": new Error("EACCES: permission denied") }));
    const review = job(view, "Automatic PR review");
    expect(review.detail).toContain("pr-brain.effective");
    expect(review.detail).toContain("EACCES");
    expect(view.attention[0]).toContain("pr-brain.effective");
  });

  it("an unreadable switch file is unknown, not ON", () => {
    const view = readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.off": new Error("EACCES: permission denied") }));
    expect(job(view, "Automatic PR review").state).toBe("unknown");
    expect(view.attention[0]).toContain("pr-brain.off");
  });

  it("merge=0 says the founder merges", () => {
    const brain = `written=${sec(NOW - 60_000)}\nengine=agy\nreviewers=model-a\nmerge=0\n`;
    const review = job(readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.effective": brain })), "Automatic PR review");
    expect(review.detail).toContain("never merges: you merge");
  });

  it("two problems are counted and both listed", () => {
    const view = readBackgroundJobs(deps({ ...HEALTHY, "pr-brain.off": "x", "agent-dispatch.down": "gh-auth\n2026-10-04 12:10 UTC\n" }));
    expect(view.summary.startsWith("2 things need attention")).toBe(true);
    expect(view.attention).toHaveLength(2);
  });
});
