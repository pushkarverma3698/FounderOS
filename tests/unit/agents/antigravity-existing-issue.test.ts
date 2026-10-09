/**
 * "Start work on issue #41" — dispatch works on THAT issue, never a wrapper.
 * =========================================================================
 * Prod, 2026-10-07 10:40–10:46 UTC (agents.conversation_turns): "In oplify-messaging-api \nStart work on issue #41."
 * The bot filed OplifyMessage/oplify-messaging-api#83, whose whole body was "Start work on issue #41", without
 * reading #41, then said "an Antigravity agent has claimed it" although nothing had. PR #81
 * "feat(catalog): add multi-product carousel support (#41)" had been merged into beta on 2026-10-06.
 *
 * Driven through the real dispatch tool and the real fetchTaskFacts; only GitHub, the gate and the audit table are
 * stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockHitlGate = vi.fn();
const mockExecute = vi.fn();
const kick = vi.fn(async (..._a: unknown[]) => ({ status: "started" }));
const fixKick = vi.fn(async (..._a: unknown[]): Promise<{ status: string; reason?: string }> => ({ status: "started" }));
const hasAudited = vi.fn(async (..._a: unknown[]) => false);
const audit = vi.fn(async () => ({ written: true }));
const API = "OplifyMessage/oplify-messaging-api";
const ISSUE_URL = `https://github.com/${API}/issues/41`;
const PR_URL = `https://github.com/${API}/pull/81`;

let issue: Record<string, unknown>;
let timeline: unknown[];
let commentsBy: Record<number, unknown[]>;
let prData: Record<string, unknown>;
const MERGED_PR = {
  number: 81, html_url: PR_URL, state: "closed", merged: true, draft: false,
  head: { sha: "abc1234", ref: "task/issue-78-carousel" }, base: { ref: "beta" },
};
const gh = {
  get: vi.fn(async () => ({ data: issue })),
  listComments: vi.fn(async (a: { issue_number: number }) => ({ data: commentsBy[a.issue_number] ?? [] })),
  update: vi.fn(async () => ({})),
  addLabels: vi.fn(async () => ({})),
  removeLabel: vi.fn(async () => ({})),
  createComment: vi.fn(async () => ({})),
  listForRepo: vi.fn(async () => ({ data: [] })),
  listEventsForTimeline: vi.fn(),
  pullsList: vi.fn(async () => ({ data: [{ number: 81, head: { ref: "task/issue-78-carousel" } }] })),
  pullsGet: vi.fn(async () => ({ data: prData })),
  paginate: vi.fn(async () => timeline),
};

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  hitlGate: (...a: unknown[]) => mockHitlGate(...a),
}));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: (...a: unknown[]) => hasAudited(...a),
  writeAuditEntry: (...a: unknown[]) => audit(...(a as [])),
  listRegisteredDispatchRepos: async () => [],
}));
vi.mock("../../../src/tools/dispatch-antigravity.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  dispatchAntigravityTool: { execute: (...a: unknown[]) => mockExecute(...a) },
}));
vi.mock("../../../src/tools/coding-engine.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  readDefaultEngine: () => "agy",
}));
vi.mock("../../../src/tools/dispatch-tick.js", () => ({
  startDispatchJob: (...a: unknown[]) => kick(...a),
  startFixJob: (...a: unknown[]) => fixKick(...a),
  startFailureNote: (n: number, repo: string, why: string) => `${repo}#${n} was filed but its run did not start: ${why}`,
}));
vi.mock("octokit", () => ({
  Octokit: vi.fn(() => ({
    paginate: gh.paginate,
    rest: {
      issues: {
        get: gh.get, listComments: gh.listComments, update: gh.update, addLabels: gh.addLabels,
        removeLabel: gh.removeLabel, createComment: gh.createComment, listForRepo: gh.listForRepo,
        listEventsForTimeline: gh.listEventsForTimeline,
      },
      pulls: { list: gh.pullsList, get: gh.pullsGet },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    },
  })),
}));

process.env["GITHUB_TOKEN"] = "test";
const { dispatchAntigravityTask } = await import("../../../src/agents/agent-tools/antigravity.js");
const { requeueAntigravityTask } = await import("../../../src/agents/agent-tools/antigravity-followup.js");
const { NO_ACTION_PREFIX, isFailureResult } = await import("../../../src/kernel/tool-failure.js");
const { extractAsk } = await import("../../../src/tools/pipeline-spec.js");
const { PIPELINE_V2_FLAG } = await import("../../../src/tools/pipeline-pending.js");

const FOUNDER = "In oplify-messaging-api \nStart work on issue #41.";
const PROD_CALL = { title: "Start work on issue #41", founder_request: FOUNDER, repo: API };
const PR_81_ON_TIMELINE = {
  event: "cross-referenced",
  source: {
    issue: {
      number: 81, title: "feat(catalog): add multi-product carousel support (#41)", body: "", state: "closed",
      html_url: PR_URL, repository: { full_name: API }, pull_request: { merged_at: "2026-10-06T09:35:19Z" },
    },
  },
};

function issue41(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 41,
    title: "[PROD-010] Catalog: no multi-product carousel, only single product card",
    body: "**Severity:** P2\n\nCatalog messages send a single product card; customers asked for a carousel.",
    state: "open",
    labels: [{ name: "P2" }, { name: "bug-tracker-import" }],
    created_at: "2026-09-20T00:00:00Z",
    html_url: ISSUE_URL,
    ...over,
  };
}

function noWrites(): void {
  expect(mockExecute).not.toHaveBeenCalled();
  expect(gh.update).not.toHaveBeenCalled();
  expect(gh.addLabels).not.toHaveBeenCalled();
  expect(gh.createComment).not.toHaveBeenCalled();
  expect(kick).not.toHaveBeenCalled();
  expect(fixKick).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHitlGate.mockResolvedValue(null);
  issue = issue41();
  timeline = [];
  commentsBy = {};
  prData = MERGED_PR;
  hasAudited.mockResolvedValue(false);
  fixKick.mockResolvedValue({ status: "started" });
  delete process.env[PIPELINE_V2_FLAG];
});
afterEach(() => {
  delete process.env[PIPELINE_V2_FLAG];
});

describe("dispatch_antigravity_task on a request that names an existing issue", () => {
  it("the prod case: #41 is already fixed by merged PR #81 — says so with the link, files nothing, asks nothing", async () => {
    timeline = [PR_81_ON_TIMELINE];

    const res: string = await dispatchAntigravityTask.invoke(PROD_CALL);

    expect(gh.get).toHaveBeenCalledWith({ owner: "OplifyMessage", repo: "oplify-messaging-api", issue_number: 41 });
    expect(mockHitlGate).not.toHaveBeenCalled();
    noWrites();
    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(isFailureResult(res)).toBe(false);
    expect(res).toContain("PR #81");
    expect(res).toContain(PR_URL);
    expect(res).not.toMatch(/claimed|picked (it )?up/i);
  });

  it("not fixed yet, pipeline v2: one card, then THIS issue gets agent:spec and the founder's words — never a new issue", async () => {
    process.env[PIPELINE_V2_FLAG] = "1";

    const res: string = await dispatchAntigravityTask.invoke(PROD_CALL);

    expect(mockHitlGate).toHaveBeenCalledOnce();
    const card = mockHitlGate.mock.calls[0]![0] as { action: string; title: string; summary: string; preview: string };
    expect(card.action).toBe("dispatch_antigravity_task");
    expect(card.title).toContain("#41");
    expect(card.summary).toMatch(/nothing new filed/i);
    expect(card.preview).toContain("single product card");

    expect(mockExecute).not.toHaveBeenCalled();
    expect(gh.addLabels).toHaveBeenCalledWith({
      owner: "OplifyMessage", repo: "oplify-messaging-api", issue_number: 41, labels: ["agent:spec", "antigravity", "engine:agy"],
    });
    const body = (gh.update.mock.calls[0] as unknown as [{ body: string; issue_number: number }])[0];
    expect(body.issue_number).toBe(41);
    expect(body.body.startsWith(issue41()["body"] as string)).toBe(true);
    const ask = extractAsk(body.body);
    expect(ask.ok && ask.ask).toContain("Start work on issue #41.");
    // Pass P sees only the ask, so the ask carries what #41 says.
    expect(ask.ok && ask.ask).toContain("single product card");
    expect(gh.createComment).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledWith(41, API, "spec");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dispatch_antigravity_task" }));

    expect(res).toMatch(/#41/);
    expect(res).toMatch(/nothing new filed/i);
    expect(res).toContain(ISSUE_URL);
    expect(res).not.toMatch(/did not start/);
  });

  it("not fixed yet, legacy pipeline: THIS issue gets agent:ready and its body is left alone", async () => {
    const res: string = await dispatchAntigravityTask.invoke(PROD_CALL);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(gh.update).not.toHaveBeenCalled();
    expect(gh.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 41, labels: ["agent:ready", "antigravity", "engine:agy"] }));
    expect(res).toMatch(/nothing new filed/i);
  });

  it("the founder rejects the card: nothing is written", async () => {
    mockHitlGate.mockResolvedValueOnce("❌ Rejected by founder.");

    const res = await dispatchAntigravityTask.invoke(PROD_CALL);

    expect(res).toBe("❌ Rejected by founder.");
    noWrites();
  });

  it("its spec is already being drafted: says so, writes nothing", async () => {
    issue = issue41({ labels: [{ name: "agent:spec" }, { name: "antigravity" }] });

    const res: string = await dispatchAntigravityTask.invoke(PROD_CALL);

    expect(mockHitlGate).not.toHaveBeenCalled();
    noWrites();
    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(res).toMatch(/spec is being drafted/i);
  });

  it("v2 needs the founder's words to bind the spec to: without them it refuses before any card", async () => {
    process.env[PIPELINE_V2_FLAG] = "1";

    const res: string = await dispatchAntigravityTask.invoke({
      title: "Start work on issue #41", goal: "g", expected: "e", verification: "v", repo: API,
    });

    expect(mockHitlGate).not.toHaveBeenCalled();
    noWrites();
    expect(res).toMatch(/^❌ .*founder_request/);
  });

  it("#N that is a pull request is refused, nothing filed", async () => {
    issue = issue41({ pull_request: { url: "x" } });

    const res: string = await dispatchAntigravityTask.invoke(PROD_CALL);

    noWrites();
    expect(res).toMatch(/^❌ #41 .*pull request/);
  });

  it("two issues named: refuses and says how to queue them one at a time, without reading or filing", async () => {
    const res: string = await dispatchAntigravityTask.invoke({ ...PROD_CALL, founder_request: "start issues #41 and #42" });

    expect(gh.get).not.toHaveBeenCalled();
    noWrites();
    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(res).toContain("#41");
    expect(res).toContain("#42");
  });
});

describe("requeue_antigravity_task on an issue no agent has had yet", () => {
  it("queues the same issue with the default engine's label, after one card", async () => {
    const res: string = await requeueAntigravityTask.invoke({ issue: 41, repo: API, founder_request: FOUNDER });

    expect(mockHitlGate).toHaveBeenCalledOnce();
    expect((mockHitlGate.mock.calls[0]![0] as { action: string }).action).toBe("requeue_antigravity_task");
    expect(gh.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 41, labels: ["agent:ready", "antigravity", "engine:agy"] }));
    expect(mockExecute).not.toHaveBeenCalled();
    expect(res).toMatch(/nothing new filed/i);
  });

  it("an issue fixed by a merged PR is not re-queued, and the reply links the PR", async () => {
    timeline = [PR_81_ON_TIMELINE];

    const res: string = await requeueAntigravityTask.invoke({ issue: 41, repo: API });

    noWrites();
    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(res).toContain(PR_URL);
  });
});

// ── Oplify #115 / PR #116, 2026-10-09: "dispatch agy to fix the issues in the same branch" ──────────────────────
// pr-brain had blocked the PR with two blockers. The bot answered "already working… requeue was not needed" (false:
// nothing ran) and the fix waited for the next cron tick. A blocked, reviewed PR is not "in progress": it is waiting
// for a fix, and the founder's word starts that fix now, on the PR's own branch, with every blocker.
describe("requeue_antigravity_task on an issue whose PR pr-brain blocked", () => {
  const HEAD = "c".repeat(40);
  const BRANCH = "task/issue-115-account-enumeration";
  const B1 = { severity: "blocker", file: "test/auth-flows.test.js", line: 244, claim: "The test expects status 404 but the route returns 401", evidence: "401 !== 404" };
  const B2 = { severity: "blocker", file: "tests/unit/enum.test.ts", claim: "A vitest test file in a repo that runs node --test", evidence: "package.json: node --test" };
  const NOTE = { severity: "minor", claim: "rename a variable", evidence: "style" };
  const verdict = (findings: object[], decision = "REQUEST_CHANGES", head = HEAD): string =>
    `Review.\n\n\`\`\`json\n${JSON.stringify({ version: 1, head_sha: head, decision, findings })}\n\`\`\`\n`;

  function blockedPr(labels: string[], opts: { prComments?: string[]; draft?: boolean } = {}): void {
    issue = issue41({ number: 115, labels: labels.map((name) => ({ name })), title: "fix: account enumeration" });
    prData = {
      number: 116, html_url: "https://github.com/OplifyMessage/oplify-messaging-api/pull/116", state: "open", merged: false,
      draft: opts.draft ?? true, head: { sha: HEAD, ref: BRANCH }, base: { ref: "beta" },
    };
    commentsBy = {
      115: [{ body: "<!-- agent-pr: 116 -->", created_at: "2026-10-09T09:00:00Z" }],
      116: (opts.prComments ?? [verdict([B1, B2, NOTE]), `<!-- brain-reviewed: ${HEAD} -->`]).map((body) => ({ body, created_at: "2026-10-09T09:30:00Z" })),
    };
  }
  const claimedMinAgo = (min: number): { body: string; created_at: string } => ({
    body: `<!-- agent-claimed: ${new Date(Date.now() - min * 60_000).toISOString()} -->`,
    created_at: "2026-10-09T05:00:00Z",
  });

  const ASK = { issue: 115, repo: API, founder_request: "Dispatch agy to fix the issues in the same branch" };

  it("starts the fix now: one card listing both blockers and the branch, then a fix job on that head — no relabel, no cron wait", async () => {
    blockedPr(["agent:review", "antigravity"]);

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(mockHitlGate).toHaveBeenCalledOnce();
    const card = mockHitlGate.mock.calls[0]![0] as { action: string; title: string; preview: string; summary: string };
    expect(card.action).toBe("requeue_antigravity_task");
    expect(card.title).toMatch(/fix/i);
    expect(card.preview).toContain("The test expects status 404 but the route returns 401");
    expect(card.preview).toContain("A vitest test file in a repo that runs node --test");
    expect(card.preview).toContain(BRANCH);
    expect(card.preview).not.toContain("rename a variable");
    expect(fixKick).toHaveBeenCalledWith(115, API, HEAD);
    expect(kick).not.toHaveBeenCalled();
    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "requeue_antigravity_task" }));
    expect(res).not.toMatch(/already in progress|already working|second run/i);
    expect(res).toContain("2 blockers");
    expect(res).toContain(BRANCH);
    expect(res).toMatch(/re-?review/i);
  });

  it("agent:blocked after 3 rounds is the same: the founder's word is the decision the label was waiting for", async () => {
    blockedPr(["agent:blocked", "antigravity"]);

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(fixKick).toHaveBeenCalledWith(115, API, HEAD);
    expect(res).not.toMatch(/needs your decision/i);
  });

  it("dispatch_antigravity_task naming the same issue takes the same path", async () => {
    blockedPr(["agent:review", "antigravity"]);

    await dispatchAntigravityTask.invoke({ title: "Fix #115", founder_request: "fix the blockers on issue #115", repo: API });

    expect((mockHitlGate.mock.calls[0]![0] as { action: string }).action).toBe("dispatch_antigravity_task");
    expect(fixKick).toHaveBeenCalledWith(115, API, HEAD);
  });

  it("the founder rejects the card: no job, no audit row", async () => {
    blockedPr(["agent:review"]);
    mockHitlGate.mockResolvedValueOnce("❌ Rejected by founder.");

    const res = await requeueAntigravityTask.invoke(ASK);

    expect(res).toBe("❌ Rejected by founder.");
    expect(fixKick).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a replay of an approval that already ran starts nothing twice", async () => {
    blockedPr(["agent:review"]);
    hasAudited.mockResolvedValueOnce(true);

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(fixKick).not.toHaveBeenCalled();
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
  });

  it("the idempotency key is bound to the head: a new commit is a new decision", async () => {
    blockedPr(["agent:review"]);
    await requeueAntigravityTask.invoke(ASK);
    const NEW_HEAD = "e".repeat(40);
    blockedPr(["agent:review"], { prComments: [verdict([B1], "REQUEST_CHANGES", NEW_HEAD), `<!-- brain-reviewed: ${NEW_HEAD} -->`] });
    prData = { ...prData, head: { sha: NEW_HEAD, ref: BRANCH } };
    await requeueAntigravityTask.invoke(ASK);
    const keys = hasAudited.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("says plainly when the job could not be handed over", async () => {
    blockedPr(["agent:review"]);
    fixKick.mockResolvedValueOnce({ status: "failed", reason: "connect ENOENT /run/fos-job.sock" });

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(res).toContain("connect ENOENT /run/fos-job.sock");
    expect(res).not.toMatch(/fix started/i);
  });

  it("says plainly when this host runs no jobs (inert): nothing is claimed as started", async () => {
    blockedPr(["agent:review"]);
    fixKick.mockResolvedValueOnce({ status: "inert" });

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(res).toMatch(/nothing (was )?started|does not run/i);
    expect(res).not.toMatch(/fix started/i);
  });

  it("pr-brain has not reviewed this head yet: nothing to fix, and it says so instead of 'already working'", async () => {
    blockedPr(["agent:review"], { prComments: [] });

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(res).toMatch(/has not (finished|reviewed)/i);
    expect(res).not.toMatch(/already in progress|second run/i);
    expect(fixKick).not.toHaveBeenCalled();
    expect(mockHitlGate).not.toHaveBeenCalled();
  });

  it("a verdict for an OLDER head is not this head's verdict: no fix on stale blockers", async () => {
    blockedPr(["agent:review"], { prComments: [verdict([B1], "REQUEST_CHANGES", "d".repeat(40)), `<!-- brain-reviewed: ${"d".repeat(40)} -->`] });

    await requeueAntigravityTask.invoke(ASK);

    expect(fixKick).not.toHaveBeenCalled();
  });

  it("an approved, cleared PR is not re-run: it says the PR is ready to merge", async () => {
    blockedPr(["agent:review"], { draft: false, prComments: [verdict([], "APPROVE"), `<!-- brain-reviewed: ${HEAD} -->`] });

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(fixKick).not.toHaveBeenCalled();
    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(res).toMatch(/cleared|ready to merge/i);
  });

  it("a run that claimed the issue 5 minutes ago is refused as running, with its age", async () => {
    issue = issue41({ number: 115, labels: [{ name: "agent:working" }] });
    commentsBy = { 115: [claimedMinAgo(5)] };

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(res.startsWith(NO_ACTION_PREFIX)).toBe(true);
    expect(res).toMatch(/claimed it 5 min ago/);
    expect(gh.addLabels).not.toHaveBeenCalled();
  });

  it("agent:working with a claim 3 hours old is a dead label, not a run: it is re-queued and the label is cleared", async () => {
    issue = issue41({ number: 115, labels: [{ name: "agent:working" }, { name: "antigravity" }] });
    commentsBy = { 115: [claimedMinAgo(180)] };

    const res: string = await requeueAntigravityTask.invoke(ASK);

    expect(gh.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 115, name: "agent:working" }));
    expect(gh.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 115, labels: expect.arrayContaining(["agent:ready"]) }));
    expect(res).not.toMatch(/already in progress|second run/i);
  });
});

// ── AG-062, Oplify #117/#119, 2026-10-09 ─────────────────────────────────────────────────────────────────────────────
// The worker wrote founder_request itself ("Pick the first open issue found in s1…"), agy built an "s1 dispatcher
// module", and "Fix issue #115" in goal filed duplicates. The founder's words come from the gateway, never the model.
describe("the founder's words come from the gateway's founder_text, and every field is read for #N", () => {
  const FOUNDER_TEXT = "work on oplify-messaging-api issue 115";
  const PLANNER_TEXT = "Pick the first open issue found in s1 and dispatch it";
  const asCfg = (founderText?: string): { configurable: Record<string, unknown> } => ({
    configurable: founderText === undefined ? {} : { founder_text: founderText },
  });
  const words = (): string => {
    const c = gh.createComment.mock.calls[0] as unknown as [{ body: string }] | undefined;
    const m = /<!-- founder-words: ([A-Za-z0-9+/=]+) -->/.exec(c?.[0].body ?? "");
    return m ? Buffer.from(m[1]!, "base64").toString("utf8") : "";
  };

  it("founder_text wins over a model-written founder_request: #115 is queued with his words", async () => {
    issue = issue41({ number: 115, title: "fix: account enumeration", labels: [] });

    await dispatchAntigravityTask.invoke(
      { title: "Dispatch s1 work", founder_request: PLANNER_TEXT, repo: API },
      asCfg(FOUNDER_TEXT),
    );

    expect(gh.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 115 }));
    expect(mockExecute).not.toHaveBeenCalled();
    expect(gh.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 115 }));
    expect(words()).toBe(FOUNDER_TEXT);
    expect(JSON.stringify(gh.createComment.mock.calls)).not.toContain(PLANNER_TEXT);
    expect(kick).toHaveBeenCalledWith(115, API, "build");
  });

  it("goal 'Fix issue #115' with a title and words naming no number: queues #115 and files nothing", async () => {
    issue = issue41({ number: 115, title: "fix: account enumeration", labels: [] });

    await dispatchAntigravityTask.invoke(
      { title: "fix: account enumeration", goal: "Fix issue #115", repo: API },
      asCfg("the login leaks which accounts exist, fix it"),
    );

    expect(gh.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 115 }));
    expect(mockExecute).not.toHaveBeenCalled();
    expect(gh.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 115 }));
    expect(kick).toHaveBeenCalledWith(115, API, "build");
  });
});
