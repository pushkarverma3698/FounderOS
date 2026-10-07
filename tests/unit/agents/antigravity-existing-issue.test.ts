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
const kick = vi.fn();
const audit = vi.fn(async () => ({ written: true }));
const API = "OplifyMessage/oplify-messaging-api";
const ISSUE_URL = `https://github.com/${API}/issues/41`;
const PR_URL = `https://github.com/${API}/pull/81`;

let issue: Record<string, unknown>;
let timeline: unknown[];
const gh = {
  get: vi.fn(async () => ({ data: issue })),
  listComments: vi.fn(async () => ({ data: [] })),
  update: vi.fn(async () => ({})),
  addLabels: vi.fn(async () => ({})),
  removeLabel: vi.fn(async () => ({})),
  createComment: vi.fn(async () => ({})),
  listForRepo: vi.fn(async () => ({ data: [] })),
  listEventsForTimeline: vi.fn(),
  pullsList: vi.fn(async () => ({ data: [{ number: 81, head: { ref: "task/issue-78-carousel" } }] })),
  pullsGet: vi.fn(async () => ({
    data: {
      number: 81, html_url: PR_URL, state: "closed", merged: true, draft: false,
      head: { sha: "abc1234", ref: "task/issue-78-carousel" }, base: { ref: "beta" },
    },
  })),
  paginate: vi.fn(async () => timeline),
};

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  hitlGate: (...a: unknown[]) => mockHitlGate(...a),
}));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: vi.fn(async () => false),
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
vi.mock("../../../src/tools/dispatch-tick.js", () => ({ kickDispatchTick: (...a: unknown[]) => kick(...a) }));
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
  expect(audit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHitlGate.mockResolvedValue(null);
  issue = issue41();
  timeline = [];
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
    expect(kick).toHaveBeenCalledWith(41, API);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dispatch_antigravity_task" }));

    expect(res).toMatch(/#41/);
    expect(res).toMatch(/nothing new filed/i);
    expect(res).toContain(ISSUE_URL);
    expect(res).toMatch(/No agent is on it yet/);
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
