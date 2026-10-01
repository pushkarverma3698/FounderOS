/**
 * Unit tests — the daily jobhunt check, end to end with fakes (plan C2 + C3).
 * ============================================================================
 * Real analyzer, real dispatch loop, real renderer, real throttle; fake database
 * reader, fake GitHub, fake Telegram, in-memory state.
 *
 * THE FAILURES THESE GUARD AGAINST.
 *  · SILENCE. Every ending, including the loop itself breaking, must send.
 *  · A CLEAN-LOOKING FAILURE. A failed data read must say "check failed", never
 *    "nothing new", and must file nothing.
 *  · SPEND. The check is deterministic code. An injected model that throws on any
 *    call proves no LLM is reached.
 *  · NAGGING. A decision that is true every morning is told once a week.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ZERO LLM: any model access on this path throws. The check must complete without touching them.
const modelAccess = vi.fn();
const throwingModel = (name: string) => (): never => {
  modelAccess(name);
  throw new Error(`LLM reached from the jobhunt check: ${name}`);
};
vi.mock("../../../src/agents/model.js", () => ({
  getModel: throwingModel("getModel"),
  getSupervisorModel: throwingModel("getSupervisorModel"),
  getWorkerModel: throwingModel("getWorkerModel"),
  buildFallbackModels: throwingModel("buildFallbackModels"),
}));
vi.mock("../../../src/agents/worker-invoke.js", () => ({
  invokeWorkerWithFallbacks: throwingModel("invokeWorkerWithFallbacks"),
}));

// The code-health audit must stay off this path.
vi.mock("../../../src/evolution/run-audit.js", () => ({
  runSelfAudit: vi.fn(async () => {
    throw new Error("the code-health audit must not run on the jobhunt path");
  }),
}));
const logError = vi.fn();
const logWarn = vi.fn();
vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() }),
}));

const { runJobhuntFindingsCheck } = await import("../../../src/evolution/jobhunt-check.js");
const { EMPTY_NOTIFY_STATE, DECISION_RENOTIFY_DAYS } = await import("../../../src/evolution/jobhunt-notify-state.js");
const { findingMarker } = await import("../../../src/evolution/issue-body.js");
const { computeFingerprint } = await import("../../../src/evolution/fingerprint.js");
const { analyzeJobhunt } = await import("../../../src/evolution/analyzers/jobhunt.js");
const { NOW, DAY, healthy, withSilent } = await import("../../helpers/jobhunt-fixtures.js");

import type { NotifyState } from "../../../src/evolution/jobhunt-notify-state.js";
import type { IssueGateway } from "../../../src/evolution/dispatch-findings.js";
import type { JobhuntSnapshot } from "../../../src/evolution/analyzers/jobhunt.js";
import type { HaltState } from "../../../src/infra/halt.js";

/** The founder's measured case: a candidate with 62 actionable roles and 0 applied. */
const NOT_ACTING = { profileId: "wife-nl-finance", candidateName: "Tashi Goyal", doToday: 28, stretch: 14, ask: 20, applied: 0, skipped: 0 };

function harness(over: { snapshot?: JobhuntSnapshot; issues?: Array<{ body: string; state: "open" | "closed" }> } = {}) {
  const issues = [...(over.issues ?? [])];
  const created: Array<{ title: string; body: string; labels: readonly string[] }> = [];
  const gateway: IssueGateway = {
    async listAutoFiledBodies() {
      return issues.map((i) => i.body);
    },
    async createIssue(input) {
      created.push(input);
      issues.push({ body: input.body, state: "open" });
      return { number: 900 + created.length, url: `https://github.com/x/y/issues/${900 + created.length}` };
    },
  };
  let stored: NotifyState = EMPTY_NOTIFY_STATE;
  const saves: NotifyState[] = [];
  const sent: string[][] = [];
  const deps = {
    now: () => NOW,
    read: vi.fn(async () => over.snapshot ?? healthy()),
    gateway: vi.fn(() => gateway),
    send: vi.fn(async (parts: readonly string[]) => {
      sent.push([...parts]);
    }),
    halt: vi.fn(async (): Promise<HaltState | null> => null),
    state: {
      load: vi.fn(async () => stored),
      save: vi.fn(async (next: NotifyState) => {
        stored = next;
        saves.push(next);
      }),
    },
  };
  return { deps, created, sent, saves, issues, stored: () => stored };
}

const head = (sent: string[][]): string => sent[0]![0]!.split("\n")[0]!.replace(/<\/?b>/g, "");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SELF_IMPROVE_DISPATCH_ENABLED"];
  process.env["GITHUB_TOKEN"] = "test-token-not-real";
});

describe("it ALWAYS sends, exactly once, whatever happens", () => {
  it("filed: the plan's first line, with the issue number and title", async () => {
    const h = harness({ snapshot: withSilent("ashby") });

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toMatch(/^Jobhunt check: filed #901 \[self-audit\] adapter-silent: ashby/);
    expect(result.outcome.state).toBe("filed");
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.labels).toEqual(["evolution:auto", "agent:ready"]);
  });

  it("nothing new: a healthy lane says so, with what was checked", async () => {
    const h = harness();

    await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toBe("Jobhunt check: nothing new");
    expect(h.sent[0]![0]).toContain("Checked:");
    expect(h.created).toHaveLength(0);
  });

  it("nothing new when the only findings already have an issue (open or closed)", async () => {
    const [finding] = analyzeJobhunt(withSilent("ashby"), NOW).findings;
    const h = harness({
      snapshot: withSilent("ashby"),
      issues: [{ body: findingMarker(computeFingerprint(finding!)), state: "closed" }],
    });

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(result.outcome.state).toBe("all-filed");
    expect(head(h.sent)).toBe("Jobhunt check: nothing new");
    expect(h.created).toHaveLength(0);
  });

  it("filing switched off: says so, and still reports decisions", async () => {
    process.env["SELF_IMPROVE_DISPATCH_ENABLED"] = "false";
    const h = harness({ snapshot: { ...healthy(), applyActivity: [NOT_ACTING] } });

    await runJobhuntFindingsCheck(h.deps);

    expect(head(h.sent)).toMatch(/^Jobhunt check: filing is switched off/);
    expect(h.sent.flat().join("\n")).toContain("62 actionable roles");
    expect(h.created).toHaveLength(0);
  });
});

describe("implementation findings are issues, never 'decisions'", () => {
  it("a filed (or already-filed) implementation finding is not also listed for the founder to decide, nor remembered as told", async () => {
    const h = harness({ snapshot: withSilent("ashby") });
    await runJobhuntFindingsCheck(h.deps);
    await runJobhuntFindingsCheck(h.deps); // second morning: already filed

    expect(h.sent.flat().join("\n")).not.toMatch(/Decisions for you/);
    expect(h.deps.state.save).not.toHaveBeenCalled();
    expect(h.stored().decisions).toEqual({});
  });

  it("only the two decision kinds ever reach the decision list, when both kinds are present", async () => {
    const snapshot: JobhuntSnapshot = { ...withSilent("ashby"), applyActivity: [NOT_ACTING] };
    const h = harness({ snapshot });

    await runJobhuntFindingsCheck(h.deps);

    const text = h.sent.flat().join("\n");
    expect(text).toContain("Decisions for you");
    expect(text.match(/<b>candidate-not-acting<\/b>/g)).toHaveLength(1);
    expect(text).not.toMatch(/<b>adapter-silent<\/b>/);
    expect(Object.values(h.stored().decisions).map((d) => d.kind)).toEqual(["candidate-not-acting"]);
  });
});

describe("edge case: the analyzer's database read fails", () => {
  it("says 'check failed: <reason>', files nothing, and does NOT claim 'nothing new'", async () => {
    const h = harness();
    h.deps.read.mockRejectedValueOnce(new Error("job_applications read failed: connect ECONNREFUSED 127.0.0.1:5432"));

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toBe(
      "Jobhunt check: check failed: reading production data: job_applications read failed: connect ECONNREFUSED 127.0.0.1:5432",
    );
    expect(h.sent.flat().join("\n")).not.toMatch(/nothing new/i);
    expect(result.outcome.state).toBe("failed");
    expect(h.created).toHaveLength(0);
    expect(h.deps.gateway).not.toHaveBeenCalled();
  });

  it("a failed read leaves the decision memory untouched, so nothing is silenced by it", async () => {
    const h = harness();
    h.deps.read.mockRejectedValueOnce(new Error("boom"));

    await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.state.save).not.toHaveBeenCalled();
  });
});

describe("edge case: filing itself breaks", () => {
  it("a missing token is a loud 'check failed', and the decisions found are still delivered", async () => {
    const h = harness({ snapshot: { ...healthy(), applyActivity: [NOT_ACTING] } });
    h.deps.gateway.mockImplementationOnce(() => {
      throw new Error("GITHUB_TOKEN is not set — the self-improvement loop cannot file an issue.");
    });

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(result.outcome.state).toBe("failed");
    expect(head(h.sent)).toMatch(/^Jobhunt check: check failed: .*GITHUB_TOKEN is not set/);
    expect(h.sent.flat().join("\n")).toContain("62 actionable roles");
  });

  it("a GitHub error while creating the issue is reported, not swallowed", async () => {
    const h = harness({ snapshot: withSilent("ashby") });
    h.deps.gateway.mockReturnValueOnce({
      listAutoFiledBodies: async () => [],
      createIssue: async () => {
        throw new Error("403 rate limited");
      },
    });

    await runJobhuntFindingsCheck(h.deps);

    expect(head(h.sent)).toMatch(/^Jobhunt check: check failed: .*403 rate limited/);
  });
});

describe("/halt is respected", () => {
  const halted: HaltState = { reason: "deploying", engagedAt: "2026-09-29T03:00:00Z", by: "founder" };

  it("reads nothing, files nothing, records nothing, and says why", async () => {
    const h = harness({ snapshot: withSilent("ashby") });
    h.deps.halt.mockResolvedValueOnce(halted);

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(result.outcome.state).toBe("halted");
    expect(h.deps.read).not.toHaveBeenCalled();
    expect(h.deps.gateway).not.toHaveBeenCalled();
    expect(h.deps.state.save).not.toHaveBeenCalled();
    expect(h.created).toHaveLength(0);
    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toMatch(/^Jobhunt check: skipped/);
    expect(h.sent.flat().join("\n")).toContain("deploying");
  });
});

describe("ZERO LLM calls", () => {
  it("completes end to end on every path with a model that throws if touched, and never touches it", async () => {
    const paths: Array<() => ReturnType<typeof harness>> = [
      () => harness({ snapshot: withSilent("ashby") }),
      () => harness(),
      () => harness({ snapshot: { ...healthy(), applyActivity: [NOT_ACTING] } }),
    ];
    for (const build of paths) {
      const h = build();
      await expect(runJobhuntFindingsCheck(h.deps)).resolves.toBeDefined();
    }

    const failing = harness();
    failing.deps.read.mockRejectedValueOnce(new Error("db down"));
    await expect(runJobhuntFindingsCheck(failing.deps)).resolves.toBeDefined();

    expect(modelAccess).not.toHaveBeenCalled();
  });
});

describe("only the jobhunt analyzer runs", () => {
  it("files a jobhunt issue and never the code-health audit (which would throw here)", async () => {
    const h = harness({ snapshot: withSilent("ashby") });
    await runJobhuntFindingsCheck(h.deps);
    expect(h.created[0]!.title).toContain("adapter-silent");
  });
});

describe("decisions are told once, then weekly (founder-lesson addition)", () => {
  const notActingSnapshot = (): JobhuntSnapshot => ({ ...healthy(), applyActivity: [NOT_ACTING] });

  it("day 0: told in full, and remembered", async () => {
    const h = harness({ snapshot: notActingSnapshot() });

    await runJobhuntFindingsCheck(h.deps);

    expect(h.sent.flat().join("\n")).toContain("62 actionable roles");
    expect(Object.keys(h.stored().decisions)).toHaveLength(1);
  });

  it("the next six mornings: 'nothing new', not the same decision again", async () => {
    const h = harness({ snapshot: notActingSnapshot() });
    await runJobhuntFindingsCheck(h.deps);
    h.sent.length = 0;

    for (let day = 1; day < DECISION_RENOTIFY_DAYS; day++) {
      h.deps.now = () => new Date(NOW.getTime() + day * DAY);
      await runJobhuntFindingsCheck(h.deps);
    }

    expect(h.sent).toHaveLength(DECISION_RENOTIFY_DAYS - 1); // still sent every day: always sends
    for (const parts of h.sent) {
      const text = parts.join("\n");
      expect(text.split("\n")[0]).toContain("Jobhunt check: nothing new");
      expect(text).not.toContain("62 actionable roles");
      expect(text).toContain("next reminder");
    }
  });

  it("day 7: told again in full", async () => {
    const h = harness({ snapshot: notActingSnapshot() });
    await runJobhuntFindingsCheck(h.deps);
    h.sent.length = 0;

    h.deps.now = () => new Date(NOW.getTime() + DECISION_RENOTIFY_DAYS * DAY);
    await runJobhuntFindingsCheck(h.deps);

    expect(h.sent.flat().join("\n")).toContain("62 actionable roles");
  });

  it("a DIFFERENT decision is told immediately, even the day after the first", async () => {
    const h = harness({ snapshot: notActingSnapshot() });
    await runJobhuntFindingsCheck(h.deps);
    h.sent.length = 0;

    const other = { ...NOT_ACTING, profileId: "pushkar-nl-tech", candidateName: "Pushkar" };
    h.deps.read.mockResolvedValue({ ...healthy(), applyActivity: [NOT_ACTING, other] });
    h.deps.now = () => new Date(NOW.getTime() + DAY);
    await runJobhuntFindingsCheck(h.deps);

    const text = h.sent.flat().join("\n");
    expect(text).toContain("pushkar-nl-tech");
    // ...but not the one already told.
    expect(text).not.toContain("wife-nl-finance (Tashi Goyal) has 62");
  });

  it("a Telegram outage does NOT mark the decision as told, so tomorrow tries again", async () => {
    const h = harness({ snapshot: notActingSnapshot() });
    h.deps.send.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await expect(runJobhuntFindingsCheck(h.deps)).resolves.toBeDefined();

    expect(h.deps.state.save).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
    expect(JSON.stringify(logError.mock.calls)).toContain("429 Too Many Requests");
  });

  it("a state file that cannot be written is logged and the run still completes", async () => {
    const h = harness({ snapshot: notActingSnapshot() });
    h.deps.state.save.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(runJobhuntFindingsCheck(h.deps)).resolves.toBeDefined();

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logWarn.mock.calls)).toContain("EACCES");
  });

  it("a decision memory that throws is treated as empty: the issue still files and the message still sends", async () => {
    const h = harness({ snapshot: withSilent("ashby") });
    h.deps.state.load.mockRejectedValueOnce(new Error("EIO: i/o error"));

    await runJobhuntFindingsCheck(h.deps);

    expect(h.created).toHaveLength(1);
    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logWarn.mock.calls)).toContain("EIO");
  });
});

describe("edge case: the same defect persists for 10 days", () => {
  it("files one issue in total across ten mornings, and still tells the founder each morning", async () => {
    // The identity staying stable while `now` moves is pinned in jobhunt-analyzer.test.ts; here the
    // same finding arrives ten times and the loop's own history must hold the line.
    const h = harness({ snapshot: withSilent("ashby") });
    expect(analyzeJobhunt(withSilent("ashby"), NOW).findings[0]!.kind).toBe("adapter-silent");

    for (let day = 0; day < 10; day++) await runJobhuntFindingsCheck(h.deps);

    expect(h.created).toHaveLength(1);
    expect(h.sent).toHaveLength(10);
    expect(head([h.sent[0]!])).toMatch(/^Jobhunt check: filed #/);
    for (const parts of h.sent.slice(1)) expect(parts[0]!.split("\n")[0]).toContain("Jobhunt check: nothing new");
  });
});
