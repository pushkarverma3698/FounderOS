/**
 * Live trace, 2026-10-09, Oplify issue #115 / PR #116. pr-brain blocked the PR with two
 * blockers at 09:54. At 09:57 the founder asked "where are we on the task in review?" and the
 * bot answered: "PR #116, branch: beta" (beta is the BASE), "round 0 of max 3 — review is not
 * yet complete", "nothing in this run explains why". All three were wrong: the verdict was on the
 * PR, with both blockers, on the current head.
 *
 * The status answer must come from the verdict on the PR: head branch, every blocker, the real
 * round, and what happens next with a time.
 */

import { describe, it, expect, vi } from "vitest";
import { describeTaskStatus, fetchTaskFacts, type TaskFacts, type TaskPr } from "../../../src/tools/antigravity-status.js";

const NOW = new Date("2026-10-09T09:57:00Z");
const HEAD = "5c0ffee5c0ffee5c0ffee5c0ffee5c0ffee5c0ff";

const BLOCKERS = [
  {
    severity: "blocker" as const,
    file: "test/auth-flows.test.js",
    line: 244,
    claim: "The test expects status 404 but the route returns 401",
    evidence: "pnpm test fails: 401 !== 404",
  },
  {
    severity: "blocker" as const,
    file: "tests/unit/account-enumeration.test.ts",
    claim: "A vitest test file in a repo that runs node --test",
    evidence: "package.json test script is node --test",
  },
];

function pr(over: Partial<TaskPr> = {}): TaskPr {
  return {
    number: 116,
    url: "https://github.com/OplifyMessage/oplify-messaging-api/pull/116",
    state: "open",
    merged: false,
    draft: true,
    headSha: HEAD,
    headRef: "task/issue-115-account-enumeration",
    baseRef: "beta",
    checks: { passed: 3, failed: 0, pending: 0 },
    reviewedHeads: [HEAD],
    attempts: 0,
    verdict: { decision: "REQUEST_CHANGES", findings: BLOCKERS },
    ...over,
  };
}

function facts(over: Partial<TaskFacts> = {}, labels = ["agent:review"]): TaskFacts {
  return {
    repo: "OplifyMessage/oplify-messaging-api",
    issue: {
      number: 115,
      title: "fix account enumeration",
      state: "open",
      labels,
      createdAt: "2026-10-09T09:00:00Z",
      url: "https://github.com/OplifyMessage/oplify-messaging-api/issues/115",
    },
    comments: [],
    pr: pr(),
    quotaUntil: null,
    ...over,
  };
}

describe("status of a reviewed, blocked PR", () => {
  const text = describeTaskStatus(facts(), NOW);

  it("names the head branch, and the base only as the merge target", () => {
    expect(text).toContain("task/issue-115-account-enumeration");
    expect(text).toMatch(/into beta/);
    expect(text).not.toMatch(/branch: beta/);
  });

  it("lists every blocker with file, line and claim", () => {
    expect(text).toContain("test/auth-flows.test.js:244");
    expect(text).toContain("returns 401");
    expect(text).toContain("tests/unit/account-enumeration.test.ts");
    expect(text).toContain("vitest test file");
  });

  it("never says the review is incomplete when a verdict exists", () => {
    expect(text).not.toMatch(/not yet complete|nothing in this run|not complete/i);
    expect(text).toMatch(/2 blockers/);
  });

  it("states the real fix round and the next step with a time", () => {
    expect(text).toMatch(/fix rounds used: 0 of 3/i);
    // cron is */15: 09:57 -> 10:00
    expect(text).toContain("10:00 UTC");
    expect(text).toMatch(/re-review/i);
  });
});

describe("status variants", () => {
  it("a review still pending at this head says when the next pr-brain run is, not 'blocked'", () => {
    const text = describeTaskStatus(facts({ pr: pr({ reviewedHeads: [], verdict: null }) }), NOW);
    expect(text).toMatch(/waiting for pr-brain's review/i);
    expect(text).toMatch(/10:00 UTC/); // */20 -> 10:00
    expect(text).not.toContain("returns 401");
  });

  it("a reviewed head whose verdict could not be read points at the PR instead of guessing", () => {
    const text = describeTaskStatus(facts({ pr: pr({ verdict: null }) }), NOW);
    expect(text).toMatch(/verdict.*could not be read|read the verdict on the PR/i);
    expect(text).toContain("/pull/116");
    expect(text).not.toMatch(/not complete/i);
  });

  it("after 3 fix rounds the blockers are still shown and nothing is promised", () => {
    const text = describeTaskStatus(facts({ pr: pr({ attempts: 3 }) }, ["agent:blocked"]), NOW);
    expect(text).toContain("test/auth-flows.test.js:244");
    expect(text).toMatch(/Nothing more happens automatically/);
  });

  it("while a fix run is working, shows what it is fixing", () => {
    const text = describeTaskStatus(facts({ pr: pr({ attempts: 1 }) }, ["agent:working"]), NOW);
    expect(text).toMatch(/working on it/);
    expect(text).toContain("test/auth-flows.test.js:244");
  });

  it("a cleared PR lists no blockers", () => {
    const text = describeTaskStatus(
      facts({ pr: pr({ draft: false, verdict: { decision: "APPROVE", findings: [] } }) }),
      NOW,
    );
    expect(text).toMatch(/cleared/);
    expect(text).not.toMatch(/blocker/i);
  });

  it("caps a long blocker list but says how many were left out", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...BLOCKERS[0]!, line: i + 1, claim: `claim ${i}` }));
    const text = describeTaskStatus(facts({ pr: pr({ verdict: { decision: "REQUEST_CHANGES", findings: many } }) }), NOW);
    expect(text).toMatch(/14 blockers/);
    expect(text).toMatch(/\+4 more blockers/);
  });
});

describe("fetchTaskFacts reads the verdict and the head branch", () => {
  const reviewComment =
    `<!-- brain-reviewed: ${HEAD} -->\n**Gate: REQUEST_CHANGES**\n\n` +
    "```json\n" +
    JSON.stringify({ version: 1, head_sha: HEAD, decision: "REQUEST_CHANGES", findings: BLOCKERS }) +
    "\n```";
  const staleComment =
    "<!-- brain-reviewed: 1111111 -->\n```json\n" +
    JSON.stringify({ version: 1, head_sha: "1111111", decision: "REQUEST_CHANGES", findings: [BLOCKERS[0]] }) +
    "\n```";

  function octokit(prComments: string[]) {
    return {
      rest: {
        issues: {
          get: vi.fn(async () => ({
            data: {
              number: 115, title: "t", body: "", state: "open", labels: [{ name: "agent:review" }],
              created_at: "2026-10-09T09:00:00Z", html_url: "https://github.com/o/r/issues/115",
            },
          })),
          listComments: vi.fn(async (p: { issue_number: number }) => ({
            data:
              p.issue_number === 116
                ? prComments.map((body) => ({ body, created_at: "2026-10-09T09:54:00Z" }))
                : [{ body: "<!-- agent-pr: 116 -->", created_at: "2026-10-09T09:30:00Z" }],
          })),
        },
        pulls: {
          get: vi.fn(async () => ({
            data: {
              number: 116, html_url: "https://github.com/o/r/pull/116", state: "open", merged: false, draft: true,
              head: { sha: HEAD, ref: "task/issue-115-account-enumeration" }, base: { ref: "beta" },
            },
          })),
          list: vi.fn(),
        },
        checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      },
    };
  }

  it("takes the verdict for the CURRENT head and the head ref", async () => {
    const f = await fetchTaskFacts(octokit([staleComment, reviewComment]) as never, "o", "r", 115, async () => null);
    expect(f.pr?.headRef).toBe("task/issue-115-account-enumeration");
    expect(f.pr?.verdict?.decision).toBe("REQUEST_CHANGES");
    expect(f.pr?.verdict?.findings).toHaveLength(2);
  });

  it("ignores a verdict that names an older head", async () => {
    const f = await fetchTaskFacts(octokit([staleComment]) as never, "o", "r", 115, async () => null);
    expect(f.pr?.verdict).toBeNull();
  });
});
