/**
 * Unit tests — the daily 09:30 cron, through the real wiring (plan C2).
 * =====================================================================
 * Captures the callback `startJobhuntFindingsCron` hands to node-cron and fires it,
 * with only the outermost edges faked: the cron library, GitHub (octokit), Telegram,
 * the database read, and the clock. Everything between (the real check, the real
 * analyzer, the real dispatch loop, the real renderer, the real state file) runs.
 *
 * This is the closest a unit test gets to "the 09:30 line arrives": the real path on
 * the VPS is NOT VERIFIED until the first scheduled morning, and this file says what
 * it does and does not stand in for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockSchedule = vi.fn();
vi.mock("node-cron", () => ({ default: { schedule: mockSchedule }, schedule: mockSchedule }));

const sendToChat = vi.fn(async (_text: string, _mode?: string) => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat }));

// GitHub: an Octokit whose issue list honours the `state` filter and remembers what is created.
const filed: Array<{ title: string; body: string; labels: string[]; state: string }> = [];
const listForRepo = vi.fn(async (args: { state?: string }) => ({
  data: filed
    .map((issue, i) => ({ number: 700 + i, state: issue.state, body: issue.body }))
    .filter((issue) => args.state === "all" || issue.state === (args.state ?? "open")),
}));
const createIssue = vi.fn(async (input: { title: string; body: string; labels: string[] }) => {
  filed.push({ ...input, state: "open" });
  return { data: { number: 700 + filed.length - 1, html_url: `https://github.com/x/y/issues/${700 + filed.length - 1}` } };
});
vi.mock("octokit", () => ({ Octokit: vi.fn(() => ({ rest: { issues: { listForRepo, create: createIssue } } })) }));

// The database read is the one edge that needs Postgres; the collector's SQL is verified separately (session note).
vi.mock("../../../src/evolution/collect-jobhunt.js", async () => {
  const { withSilent } = await import("../../helpers/jobhunt-fixtures.js");
  return { collectJobhuntSnapshot: vi.fn(async () => withSilent("ashby")) };
});

// ZERO LLM, through the real wiring.
const modelAccess = vi.fn();
const throwing = (name: string) => (): never => {
  modelAccess(name);
  throw new Error(`LLM reached from the cron: ${name}`);
};
vi.mock("../../../src/agents/model.js", () => ({
  getModel: throwing("getModel"),
  getSupervisorModel: throwing("getSupervisorModel"),
  getWorkerModel: throwing("getWorkerModel"),
  buildFallbackModels: throwing("buildFallbackModels"),
}));

const { startJobhuntFindingsCron, JOBHUNT_FINDINGS_CRON } = await import("../../../src/evolution/jobhunt-findings-cron.js");
const { appTimeZone } = await import("../../../src/core/time.js");
const { NOW } = await import("../../helpers/jobhunt-fixtures.js");

let dataRoot: string;

/** Register, then fire the captured callback exactly as node-cron would. */
async function fireOnce(): Promise<void> {
  mockSchedule.mockClear();
  startJobhuntFindingsCron();
  const [, callback] = mockSchedule.mock.calls[0] as [string, () => void, unknown];
  callback();
  await vi.waitFor(() => expect(sendToChat).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  filed.length = 0;
  dataRoot = mkdtempSync(join(tmpdir(), "jobhunt-cron-"));
  process.env["FOUNDEROS_DATA_ROOT"] = dataRoot;
  process.env["HALT_FLAG_PATH"] = join(dataRoot, "HALT"); // absent: not halted
  process.env["GITHUB_TOKEN"] = "test-token-not-real";
  delete process.env["SELF_IMPROVE_DISPATCH_ENABLED"];
  // Only the clock is faked, so vi.waitFor still has real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env["FOUNDEROS_DATA_ROOT"];
  delete process.env["HALT_FLAG_PATH"];
});

describe("registration", () => {
  it("is daily at 09:30 in the founder's timezone, registered exactly once", () => {
    startJobhuntFindingsCron();

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const [expression, callback, options] = mockSchedule.mock.calls[0]!;
    expect(expression).toBe("30 9 * * *");
    expect(expression).toBe(JOBHUNT_FINDINGS_CRON);
    expect(typeof callback).toBe("function");
    expect(options).toEqual({ timezone: appTimeZone() });
  });

  it("is not the disabled 2026-08-21 cron: neither the 08:00 audit nor the 09:00 dispatch expression", () => {
    startJobhuntFindingsCron();
    expect(mockSchedule.mock.calls.map((c) => c[0])).not.toContain("0 8 */3 * *");
    expect(mockSchedule.mock.calls.map((c) => c[0])).not.toContain("0 9 */3 * *");
  });
});

describe("firing the callback, end to end", () => {
  it("files one issue and sends one Telegram message that names it, with zero LLM calls", async () => {
    await fireOnce();

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(filed[0]!.labels).toEqual(["evolution:auto", "agent:ready"]);
    expect(filed[0]!.title).toContain("adapter-silent: ashby");
    expect(sendToChat).toHaveBeenCalledTimes(1);
    const [text, mode] = sendToChat.mock.calls[0]!;
    expect(mode).toBe("HTML");
    expect(text).toContain("Jobhunt check: filed #700");
    expect(modelAccess).not.toHaveBeenCalled();
  });

  it("the next morning finds its own issue in GitHub and files nothing more (dedupe across the real gateway)", async () => {
    await fireOnce();
    sendToChat.mockClear();

    await fireOnce();

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: "all", labels: "evolution:auto" }));
    expect(sendToChat.mock.calls[0]![0]).toContain("Jobhunt check: nothing new");
  });

  it("does not run at all while FounderOS is halted, but still says so", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dataRoot, "HALT"), JSON.stringify({ reason: "deploying", engagedAt: "2026-09-29T03:00:00Z", by: "founder" }));

    await fireOnce();

    expect(createIssue).not.toHaveBeenCalled();
    expect(sendToChat.mock.calls[0]![0]).toMatch(/Jobhunt check: skipped/);
    expect(sendToChat.mock.calls[0]![0]).toContain("deploying");
  });

  it("a Telegram outage never becomes an unhandled rejection in the bot process", async () => {
    sendToChat.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await fireOnce();
    // Let the callback's promise chain settle; vitest fails the run on any unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));

    expect(createIssue).toHaveBeenCalledTimes(1); // the issue exists even though the message did not arrive
  });
});

describe("the decision memory lands under the data root that survives deploys", () => {
  it("writes jobhunt-findings-state.json there after a delivered decision, and not before", async () => {
    const stateFile = join(dataRoot, "jobhunt-findings-state.json");
    expect(existsSync(stateFile)).toBe(false);

    // The default fixture has no decision; add one by making the read return a not-acting candidate.
    const collect = await import("../../../src/evolution/collect-jobhunt.js");
    const { healthy } = await import("../../helpers/jobhunt-fixtures.js");
    vi.mocked(collect.collectJobhuntSnapshot).mockResolvedValueOnce({
      ...healthy(),
      applyActivity: [
        { profileId: "wife-nl-finance", candidateName: "Tashi Goyal", doToday: 28, stretch: 14, ask: 20, applied: 0, skipped: 0 },
      ],
    });

    await fireOnce();
    await vi.waitFor(() => expect(existsSync(stateFile)).toBe(true));

    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { version: number; decisions: Record<string, { kind: string }> };
    expect(saved.version).toBe(1);
    expect(Object.values(saved.decisions).map((d) => d.kind)).toEqual(["candidate-not-acting"]);
  });
});
