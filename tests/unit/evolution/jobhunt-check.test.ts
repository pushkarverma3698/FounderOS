/**
 * Unit tests — the daily jobhunt check, end to end with fakes (plan C2 + C3).
 * ============================================================================
 * Real analyzer, real renderer, real throttle; fake database reader, fake
 * Telegram, in-memory state. Report-only since 2026-10-10: no GitHub issue is
 * filed (agent-dispatch is retired), so every finding is told to the founder.
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

const logError = vi.fn();
const logWarn = vi.fn();
vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() }),
}));

const { runJobhuntFindingsCheck } = await import("../../../src/evolution/jobhunt-check.js");
const { EMPTY_NOTIFY_STATE, DECISION_RENOTIFY_DAYS } = await import("../../../src/evolution/jobhunt-notify-state.js");
const { analyzeJobhunt } = await import("../../../src/evolution/analyzers/jobhunt.js");
const { NOW, DAY, healthy, withSilent } = await import("../../helpers/jobhunt-fixtures.js");

import type { NotifyState } from "../../../src/evolution/jobhunt-notify-state.js";
import type { JobhuntSnapshot } from "../../../src/evolution/analyzers/jobhunt.js";

/** The founder's measured case: a candidate with 62 actionable roles and 0 applied. */
const NOT_ACTING = { profileId: "wife-nl-finance", candidateName: "Tashi Goyal", doToday: 28, stretch: 14, ask: 20, applied: 0, skipped: 0 };

function harness(over: { snapshot?: JobhuntSnapshot } = {}) {
  let stored: NotifyState = EMPTY_NOTIFY_STATE;
  const sent: string[][] = [];
  const deps = {
    now: () => NOW,
    read: vi.fn(async () => over.snapshot ?? healthy()),
    send: vi.fn(async (parts: readonly string[]) => {
      sent.push([...parts]);
    }),
    state: {
      load: vi.fn(async () => stored),
      save: vi.fn(async (next: NotifyState) => {
        stored = next;
      }),
    },
  };
  return { deps, sent, stored: () => stored };
}

const head = (sent: string[][]): string => sent[0]![0]!.split("\n")[0]!.replace(/<\/?b>/g, "");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("it ALWAYS sends, exactly once, whatever happens", () => {
  it("a code finding (silent adapter) is told to the founder with the file to fix, and nothing is filed", async () => {
    const h = harness({ snapshot: withSilent("ashby") });

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toBe("Jobhunt check: 1 finding for you");
    expect(result.outcome.state).toBe("checked");
    const text = h.sent.flat().join("\n");
    expect(text).toContain("<b>adapter-silent</b>");
    expect(text).toContain("src/tools/jobhunt/adapters/ashby.ts");
    expect(text).not.toMatch(/agent-dispatch|issue/i);
  });

  it("nothing new: a healthy lane says so, with what was checked", async () => {
    const h = harness();

    await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toBe("Jobhunt check: nothing new");
    expect(h.sent[0]![0]).toContain("Checked:");
  });

  it("both kinds present: each is told once", async () => {
    const h = harness({ snapshot: { ...withSilent("ashby"), applyActivity: [NOT_ACTING] } });

    await runJobhuntFindingsCheck(h.deps);

    const text = h.sent.flat().join("\n");
    expect(head(h.sent)).toBe("Jobhunt check: 2 findings for you");
    expect(text.match(/<b>candidate-not-acting<\/b>/g)).toHaveLength(1);
    expect(text.match(/<b>adapter-silent<\/b>/g)).toHaveLength(1);
    expect(Object.values(h.stored().decisions).map((d) => d.kind).sort()).toEqual(["adapter-silent", "candidate-not-acting"]);
  });
});

describe("edge case: the analyzer's database read fails", () => {
  it("says 'check failed: <reason>' and does NOT claim 'nothing new'", async () => {
    const h = harness();
    h.deps.read.mockRejectedValueOnce(new Error("job_applications read failed: connect ECONNREFUSED 127.0.0.1:5432"));

    const result = await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(head(h.sent)).toBe(
      "Jobhunt check: check failed: reading production data: job_applications read failed: connect ECONNREFUSED 127.0.0.1:5432",
    );
    expect(h.sent.flat().join("\n")).not.toMatch(/nothing new/i);
    expect(result.outcome.state).toBe("failed");
  });

  it("a failed read leaves the finding memory untouched, so nothing is silenced by it", async () => {
    const h = harness();
    h.deps.read.mockRejectedValueOnce(new Error("boom"));

    await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.state.save).not.toHaveBeenCalled();
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

describe("findings are told once, then weekly (founder-lesson addition)", () => {
  const notActingSnapshot = (): JobhuntSnapshot => ({ ...healthy(), applyActivity: [NOT_ACTING] });

  it("day 0: told in full, and remembered", async () => {
    const h = harness({ snapshot: notActingSnapshot() });

    await runJobhuntFindingsCheck(h.deps);

    expect(h.sent.flat().join("\n")).toContain("62 actionable roles");
    expect(Object.keys(h.stored().decisions)).toHaveLength(1);
  });

  it("the next six mornings: 'nothing new', not the same finding again", async () => {
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

  it("a DIFFERENT finding is told immediately, even the day after the first", async () => {
    const h = harness({ snapshot: notActingSnapshot() });
    await runJobhuntFindingsCheck(h.deps);
    h.sent.length = 0;

    const other = { ...NOT_ACTING, profileId: "pushkar-nl-tech", candidateName: "Pushkar" };
    h.deps.read.mockResolvedValue({ ...healthy(), applyActivity: [NOT_ACTING, other] });
    h.deps.now = () => new Date(NOW.getTime() + DAY);
    await runJobhuntFindingsCheck(h.deps);

    const text = h.sent.flat().join("\n");
    expect(text).toContain("pushkar-nl-tech");
    expect(text).not.toContain("wife-nl-finance (Tashi Goyal) has 62");
  });

  it("a Telegram outage does NOT mark the finding as told, so tomorrow tries again", async () => {
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

  it("a memory that throws is treated as empty: the message still sends", async () => {
    const h = harness({ snapshot: withSilent("ashby") });
    h.deps.state.load.mockRejectedValueOnce(new Error("EIO: i/o error"));

    await runJobhuntFindingsCheck(h.deps);

    expect(h.deps.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logWarn.mock.calls)).toContain("EIO");
  });
});
