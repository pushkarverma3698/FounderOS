/**
 * "Where are we on #762?" — asked about a dozen times in the founder's chat
 * between 09-15 and 09-28. The bot answered with github_read list_issues (every
 * open issue, labels only), then guessed: "Antigravity is actively executing in
 * its isolated workspace" for an issue that had failed with 0 commits, "no PR
 * because the PR does not exist" about a PR that did, and "I'll monitor it and
 * keep you posted" with nothing monitoring anything.
 *
 * describeTaskStatus turns the facts GitHub and the dispatcher actually hold
 * into one legible answer. Pure: every fact is passed in, including "now".
 */

import { describe, it, expect } from "vitest";
import { describeTaskStatus, type TaskFacts } from "../../../src/tools/antigravity-status.js";

const NOW = new Date("2026-09-28T18:59:53Z");

function facts(over: Partial<TaskFacts> = {}): TaskFacts {
  return {
    repo: "pushkarverma3698/FounderOS",
    issue: {
      number: 762,
      title: "feat(jev-ai): integrate Jev AI",
      state: "open",
      labels: ["antigravity", "agent:ready"],
      createdAt: "2026-09-28T18:45:09Z",
      url: "https://github.com/pushkarverma3698/FounderOS/issues/762",
    },
    comments: [],
    pr: null,
    quotaUntil: null,
    ...over,
  };
}

describe("describeTaskStatus", () => {
  it("queued: says when the dispatcher runs next, in UTC, and that nothing has started", () => {
    const text = describeTaskStatus(facts(), NOW);
    expect(text).toMatch(/^#762 feat\(jev-ai\)/);
    expect(text).toMatch(/Queued/);
    expect(text).toContain("19:00 UTC");
    expect(text).not.toMatch(/working|executing|in progress/i);
  });

  it("queued behind an exhausted quota: says so and when it lifts", () => {
    const text = describeTaskStatus(facts({ quotaUntil: new Date("2026-10-01T06:00:00Z") }), NOW);
    expect(text).toMatch(/quota/i);
    expect(text).toContain("2026-10-01 06:00 UTC");
  });

  it("working: says how long ago it was claimed and that runs are cut off at 30 minutes", () => {
    const text = describeTaskStatus(
      facts({
        issue: { ...facts().issue, labels: ["antigravity", "agent:working"] },
        comments: [{ body: "<!-- agent-claimed: 2026-09-28T18:47:00Z --> 🤖 Claimed", createdAt: "2026-09-28T18:47:00Z" }],
      }),
      NOW,
    );
    expect(text).toMatch(/Antigravity is working on it/);
    expect(text).toMatch(/claimed 12 min ago/);
    expect(text).toMatch(/30 min/);
  });

  it("failed: shows the dispatcher's own reason and offers the re-queue, not a new issue", () => {
    const text = describeTaskStatus(
      facts({
        issue: { ...facts().issue, labels: ["antigravity", "agent:failed"] },
        comments: [
          {
            body:
              "agent-dispatch could not verify a PR landed after Antigravity ran (exit=0, commits=0, pr=none).\n" +
              "This is a dispatch-level failure, not a review verdict.\n```\nroot agent idle; waiting for 2 background task(s)\n```",
            createdAt: "2026-09-28T19:30:00Z",
          },
        ],
      }),
      NOW,
    );
    expect(text).toMatch(/failed/i);
    expect(text).toContain("exit=0, commits=0, pr=none");
    expect(text).toMatch(/re-queue/i);
    expect(text).not.toMatch(/new issue/i);
  });

  it("in review: PR number, CI counts, and the reviewer's verdict for the CURRENT head", () => {
    const text = describeTaskStatus(
      facts({
        issue: { ...facts().issue, labels: ["antigravity", "agent:review"] },
        pr: {
          number: 763,
          url: "https://github.com/pushkarverma3698/FounderOS/pull/763",
          state: "open",
          merged: false,
          draft: false,
          headSha: "8d6a241dc6d313b152db28b26864e1c3f90ba4c3",
          baseRef: "beta",
          checks: { passed: 6, failed: 0, pending: 0 },
          reviewedHeads: ["220e6ec72333cfd41e5cfea275cda5ee67baa5c0", "8d6a241dc6d313b152db28b26864e1c3f90ba4c3"],
          attempts: 1,
        },
      }),
      NOW,
    );
    expect(text).toContain("PR #763");
    expect(text).toMatch(/CI: 6\/6 passed/);
    expect(text).toMatch(/Claude reviewed the current head.*cleared/i);
  });

  it("in review, not yet reviewed at this head: says the review is pending", () => {
    const text = describeTaskStatus(
      facts({
        issue: { ...facts().issue, labels: ["antigravity", "agent:review"] },
        pr: {
          number: 763,
          url: "u",
          state: "open",
          merged: false,
          draft: true,
          headSha: "bbbb",
          baseRef: "beta",
          checks: { passed: 2, failed: 1, pending: 1 },
          reviewedHeads: ["aaaa"],
          attempts: 0,
        },
      }),
      NOW,
    );
    expect(text).toMatch(/waiting for Claude's review/i);
    expect(text).toMatch(/CI: 1 failing/);
  });

  it("merged: done, into which branch", () => {
    const text = describeTaskStatus(
      facts({
        issue: { ...facts().issue, state: "closed", labels: ["antigravity", "agent:review"] },
        pr: {
          number: 763, url: "u", state: "closed", merged: true, draft: false, headSha: "x",
          baseRef: "beta", checks: { passed: 6, failed: 0, pending: 0 }, reviewedHeads: ["x"], attempts: 0,
        },
      }),
      NOW,
    );
    expect(text).toMatch(/Done — PR #763 merged into beta/);
  });

  it("never promises monitoring that does not exist — it names the real notifications", () => {
    const text = describeTaskStatus(facts(), NOW);
    expect(text).not.toMatch(/I'll monitor|keep you posted/i);
    expect(text).toMatch(/Telegram message/);
  });
});
