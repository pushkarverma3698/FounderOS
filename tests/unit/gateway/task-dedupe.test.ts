/**
 * Dedupe for /task (UX audit F16): a request that is already queued or in review is answered with its issue
 * number instead of being filed a second time. The matcher is pure; only the GitHub read is mocked.
 */

import { describe, it, expect, vi } from "vitest";

const gh = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("octokit", () => ({ Octokit: vi.fn(() => gh.client) }));

import {
  alreadyQueuedMessage,
  fetchQueuedIssues,
  findQueuedDuplicate,
  referencedIssueNumbers,
  type QueuedIssue,
} from "../../../src/gateway/task-dedupe.js";

const issue = (over: Partial<QueuedIssue> = {}): QueuedIssue => ({
  number: 77,
  title: "fix: flaky CSV export",
  body: "## Evidence\n\n> fix the flaky csv export in the jobhunt brief\n",
  state: "ready",
  ...over,
});

describe("referencedIssueNumbers", () => {
  it("reads #N and issue URLs, once each", () => {
    expect(referencedIssueNumbers("do #29 and #41, see https://github.com/o/r/issues/29")).toEqual([29, 41]);
  });
  it("finds nothing in plain words", () => {
    expect(referencedIssueNumbers("fix the login")).toEqual([]);
  });
});

describe("findQueuedDuplicate", () => {
  it("matches a request that names the queued issue itself", () => {
    expect(findQueuedDuplicate("dispatch #77 again", [issue()])?.number).toBe(77);
  });

  it("matches a request naming the issue an already-filed task points at (#38 → filed as #77)", () => {
    const wrapper = issue({ number: 77, body: "## Goal\n\nImplement #38 end to end." });
    expect(findQueuedDuplicate("please do #38", [wrapper])?.number).toBe(77);
  });

  it("does not match #3 against an issue that only mentions #38", () => {
    const other = issue({ number: 77, body: "Implement #38.", title: "t" });
    expect(findQueuedDuplicate("please do #3", [other])).toBeNull();
  });

  it("matches the same request re-sent, ignoring case, quoting and punctuation", () => {
    expect(findQueuedDuplicate("Fix the flaky CSV export in the jobhunt brief!", [issue()])?.number).toBe(77);
  });

  it("leaves a different request alone", () => {
    expect(findQueuedDuplicate("add dark mode to the settings page", [issue()])).toBeNull();
  });

  it("does not treat a very short request as a duplicate of anything that contains it", () => {
    expect(findQueuedDuplicate("fix it", [issue({ body: "we must fix it soon, fix it properly" })])).toBeNull();
  });

  it("ignores states that are not in flight (blocked, failed are for a human, not the queue)", () => {
    expect(findQueuedDuplicate("dispatch #77", [issue({ state: "blocked" as never })])).toBeNull();
  });

  it("returns null for an empty queue", () => {
    expect(findQueuedDuplicate("dispatch #77", [])).toBeNull();
  });
});

describe("alreadyQueuedMessage", () => {
  it("says 'already queued as #N' with the real number and what state it is in", () => {
    expect(alreadyQueuedMessage(issue({ number: 77, state: "ready" }))).toContain("already queued as #77");
    expect(alreadyQueuedMessage(issue({ number: 78, state: "working" }))).toContain("already queued as #78");
  });
  it("says it is in review when a PR is open", () => {
    expect(alreadyQueuedMessage(issue({ number: 79, state: "review" }))).toMatch(/#79.*in review/);
  });
});

describe("fetchQueuedIssues", () => {
  const labelled = (n: number, label: string, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `t${n}`,
    body: `b${n}`,
    labels: [{ name: label }],
    ...extra,
  });

  it("keeps ready/working/review issues, drops PRs, blocked, failed and unlabelled", async () => {
    gh.client = {
      rest: {
        issues: {
          listForRepo: vi.fn().mockResolvedValue({
            data: [
              labelled(1, "agent:ready"),
              labelled(2, "agent:working"),
              labelled(3, "agent:review"),
              labelled(4, "agent:blocked"),
              labelled(5, "agent:failed"),
              labelled(6, "bug"),
              labelled(7, "agent:ready", { pull_request: {} }),
            ],
          }),
        },
      },
    };
    const prev = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "test-token";
    try {
      const got = await fetchQueuedIssues("pushkarverma3698/FounderOS");
      expect(got.map((i) => [i.number, i.state])).toEqual([
        [1, "ready"],
        [2, "working"],
        [3, "review"],
      ]);
    } finally {
      if (prev === undefined) delete process.env["GITHUB_TOKEN"];
      else process.env["GITHUB_TOKEN"] = prev;
    }
  });

  it("throws when there is no token, so the caller can say the check was skipped", async () => {
    const prev = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      await expect(fetchQueuedIssues("pushkarverma3698/FounderOS")).rejects.toThrow(/GITHUB_TOKEN/);
    } finally {
      if (prev !== undefined) process.env["GITHUB_TOKEN"] = prev;
    }
  });
});
