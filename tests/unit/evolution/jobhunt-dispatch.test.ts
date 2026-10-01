/**
 * Unit tests — the jobhunt findings ride the EXISTING acting loop, and nothing else.
 * ==================================================================================
 * Plan part C2. The loop's header comments name `resolveExecutorCwd` as the way the
 * old acting loop died, so these tests prove the path that is being re-enabled
 * today only FILES an issue: a fake `IssueGateway` and mocked executors that throw
 * if touched, plus a static walk of the import graph.
 *
 * Also pins the plan's edge cases that belong to the loop:
 *   · the same finding persisting for 10 days files ONE issue in total,
 *   · an issue the founder closed as won't-fix still suppresses a re-file
 *     (history is read with `state: "all"`),
 *   · a paused dispatcher (quota, auth) does not stop the issue being filed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The old failure. Any of these being called is the test failing, loudly.
const executorTouched = vi.fn();
const refuse = (name: string) => (): never => {
  executorTouched(name);
  throw new Error(`the executor was touched: ${name}`);
};
vi.mock("../../../src/tools/claude-code.js", () => ({
  claudeCodeTool: { execute: refuse("claudeCodeTool.execute") },
  resolveExecutorCwd: refuse("resolveExecutorCwd"),
}));
vi.mock("../../../src/tools/claude-code-cwd.js", () => ({ resolveExecutorCwd: refuse("claude-code-cwd") }));
vi.mock("../../../src/tools/opencode.js", () => ({ resolveExecutorCwd: refuse("opencode") }));

// The code-health analyzers stay disabled for this path: reaching the full audit is a failure here.
const runSelfAudit = vi.fn(async () => {
  throw new Error("the code-health audit must not run on the jobhunt path");
});
vi.mock("../../../src/evolution/run-audit.js", () => ({ runSelfAudit }));
vi.mock("../../../src/evolution/repo-root.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/evolution/repo-root.js")>()),
  repoRoot: () => "/repo",
}));

const listForRepo = vi.fn();
const createIssueApi = vi.fn();
vi.mock("octokit", () => ({
  Octokit: vi.fn(() => ({ rest: { issues: { listForRepo, create: createIssueApi } } })),
}));

const { runSelfImprovementDispatch, octokitIssueGateway, parseFiledFingerprints } = await import(
  "../../../src/evolution/dispatch-findings.js"
);
const { analyzeJobhunt } = await import("../../../src/evolution/analyzers/jobhunt.js");
const { computeFingerprint } = await import("../../../src/evolution/fingerprint.js");
const { findingMarker } = await import("../../../src/evolution/issue-body.js");
const { importsOf, resolveImport } = await import("../../../scripts/verify-architecture.js");
const { NOW, DAY, healthy, postings, withSilent } = await import("../../helpers/jobhunt-fixtures.js");

import type { Finding } from "../../../src/evolution/types.js";
import type { FindingSource, IssueGateway } from "../../../src/evolution/dispatch-findings.js";
import type { JobhuntSnapshot } from "../../../src/evolution/analyzers/jobhunt.js";

/** A gateway that remembers what it filed, like GitHub does, and can hold issues in any state. */
function memoryGateway(seed: ReadonlyArray<{ body: string; state: "open" | "closed" }> = []) {
  const issues = seed.map((i, n) => ({ number: 100 + n, ...i }));
  const created: Array<{ title: string; body: string; labels: readonly string[] }> = [];
  const calls: string[] = [];
  const gateway: IssueGateway = {
    async listAutoFiledBodies() {
      calls.push("listAutoFiledBodies");
      return issues.map((i) => i.body); // every state, newest irrelevant
    },
    async createIssue(input) {
      calls.push("createIssue");
      created.push(input);
      issues.push({ number: 500 + created.length, body: input.body, state: "open" });
      return { number: 500 + created.length, url: `https://github.com/x/y/issues/${500 + created.length}` };
    },
  };
  return { gateway, created, calls, issues };
}

function sourceOf(findings: readonly Finding[]): FindingSource {
  return async () => ({ ranked: findings, telemetrySkippedReason: null });
}

const linkSnapshot: JobhuntSnapshot = {
  ...healthy(),
  newPostings: [
    ...postings("smartrecruiters", 14, { fromHoursAgo: 120, toHoursAgo: 3 }, { hasFormLink: false }),
    ...postings("smartrecruiters", 26, { fromHoursAgo: 118, toHoursAgo: 2 }, { hasFormLink: true }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SELF_IMPROVE_DISPATCH_ENABLED"];
  delete process.env["SELF_IMPROVE_ISSUE_REPO"];
  process.env["GITHUB_TOKEN"] = "test-token-not-real";
});

describe("today's path only FILES an issue and never touches the executor", () => {
  it("files exactly one issue through the gateway; no executor is called and the code-health audit never runs", async () => {
    const { gateway, created } = memoryGateway();
    const { findings } = analyzeJobhunt(withSilent("ashby"), NOW);

    const outcome = await runSelfImprovementDispatch(gateway, NOW, sourceOf(findings));

    expect(outcome.state).toBe("filed");
    expect(created).toHaveLength(1);
    expect(executorTouched).not.toHaveBeenCalled();
    expect(runSelfAudit).not.toHaveBeenCalled();
  });

  it("the gateway is the only thing it talks to: a history read and a create, nothing else", async () => {
    const { gateway, calls } = memoryGateway();
    const { findings } = analyzeJobhunt(withSilent("ashby"), NOW);

    await runSelfImprovementDispatch(gateway, NOW, sourceOf(findings));

    expect(calls).toEqual(["listAutoFiledBodies", "createIssue"]);
  });

  it("STATIC: no module the acting loop or its entry points can import reaches an executor, an agent or the kernel", () => {
    const root = process.cwd();
    const fileFor = (spec: string): string | null =>
      [`${spec}.ts`, `${spec}/index.ts`].find((candidate) => existsSync(join(root, candidate))) ?? null;
    const runtimeImports = (text: string): string[] =>
      // `import type` is erased by the compiler: it is not a runtime edge.
      importsOf(text.replace(/^\s*import\s+type\s[^;]*;/gm, ""));

    const entries = [
      "src/evolution/dispatch-findings.ts",
      "src/evolution/dispatch-sweep.ts",
      "src/evolution/jobhunt-check.ts",
      "src/evolution/jobhunt-findings-cron.ts",
    ];
    const seen = new Set<string>();
    const stack = [...entries];
    while (stack.length > 0) {
      const rel = stack.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      for (const spec of runtimeImports(readFileSync(join(root, rel), "utf8"))) {
        const resolved = resolveImport(rel, spec);
        const file = resolved ? fileFor(resolved) : null;
        if (file) stack.push(file);
      }
    }

    expect(seen.size).toBeGreaterThan(entries.length); // the walk really walked
    const forbidden = [...seen].filter((f) => /^src\/(tools\/(claude-code|opencode)|agents\/|kernel\/)/.test(f));
    expect(forbidden).toEqual([]);
  });
});

describe("one issue per run, however many findings", () => {
  it("files the highest-ranked implementation finding only, labelled for dedupe and for the dispatcher", async () => {
    const { gateway, created } = memoryGateway();
    const snapshot: JobhuntSnapshot = {
      ...withSilent("ashby"),
      newPostings: [...withSilent("ashby").newPostings, ...linkSnapshot.newPostings],
    };
    const { findings } = analyzeJobhunt(snapshot, NOW);
    expect(findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["adapter-silent", "apply-link-unrecognised"]),
    );

    await runSelfImprovementDispatch(gateway, NOW, sourceOf(findings));

    expect(created).toHaveLength(1);
    expect(created[0]!.labels).toEqual(["evolution:auto", "agent:ready"]);
    expect(created[0]!.title).toContain("adapter-silent");
  });

  it("decision findings alone file nothing", async () => {
    const { gateway, created } = memoryGateway();
    const snapshot: JobhuntSnapshot = {
      ...healthy(),
      laneHeartbeats: [{ profileId: "wife-nl-finance", zeroPassStreak: 12, lastFunnel: null }],
      applyActivity: [{ profileId: "wife-nl-finance", doToday: 28, stretch: 14, ask: 20, applied: 0, skipped: 0 }],
    };
    const { findings } = analyzeJobhunt(snapshot, NOW);
    expect(findings.map((f) => f.kind).sort()).toEqual(["candidate-not-acting", "lane-silent"]);

    const outcome = await runSelfImprovementDispatch(gateway, NOW, sourceOf(findings));

    expect(outcome).toEqual({ state: "nothing-dispatchable", totalFindings: 2 });
    expect(created).toHaveLength(0);
  });

  it("the kill switch still stops it before any analysis", async () => {
    process.env["SELF_IMPROVE_DISPATCH_ENABLED"] = "false";
    const source = vi.fn(sourceOf([]));

    const outcome = await runSelfImprovementDispatch(memoryGateway().gateway, NOW, source);

    expect(outcome).toEqual({ state: "disabled" });
    expect(source).not.toHaveBeenCalled();
  });

  it("without a source it is still the full code-health audit (the other entry points are unchanged)", async () => {
    runSelfAudit.mockResolvedValueOnce({
      staticResults: [],
      telemetryResults: [],
      telemetrySkippedReason: null,
      ranked: [],
    } as never);

    const outcome = await runSelfImprovementDispatch(memoryGateway().gateway, NOW);

    expect(runSelfAudit).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe("nothing-dispatchable");
  });
});

describe("edge case: the same finding persists for 10 days", () => {
  it("files ONE issue in total; the other nine mornings report that it already has one", async () => {
    const { gateway, created } = memoryGateway();
    const { findings } = analyzeJobhunt(withSilent("ashby"), NOW);
    const states: string[] = [];

    for (let day = 0; day < 10; day++) {
      const outcome = await runSelfImprovementDispatch(gateway, new Date(NOW.getTime() + day * DAY), sourceOf(findings));
      states.push(outcome.state);
    }

    expect(created).toHaveLength(1);
    expect(states).toEqual(["filed", ...Array<string>(9).fill("all-filed")]);
  });
});

describe("edge case: the founder closes the auto-issue as won't-fix", () => {
  it("still suppresses it: a closed issue counts as filed", async () => {
    const [finding] = analyzeJobhunt(withSilent("ashby"), NOW).findings;
    const { gateway, created } = memoryGateway([
      { body: findingMarker(computeFingerprint(finding!)), state: "closed" },
    ]);

    const outcome = await runSelfImprovementDispatch(gateway, NOW, sourceOf([finding!]));

    expect(outcome.state).toBe("all-filed");
    expect(created).toHaveLength(0);
  });

  it("asks GitHub for issues in ALL states, so a closed one is even visible to the dedupe", async () => {
    // A GitHub that honours the `state` filter, holding one open and one closed auto-filed issue.
    const closedBody = findingMarker("c".repeat(64));
    const openBody = findingMarker("d".repeat(64));
    listForRepo.mockImplementation(async (args: { state?: string }) => ({
      data: [
        { number: 1, state: "open", body: openBody },
        { number: 2, state: "closed", body: closedBody },
      ].filter((i) => args.state === "all" || i.state === (args.state ?? "open")),
    }));

    const bodies = await octokitIssueGateway("pushkarverma3698/FounderOS").listAutoFiledBodies();

    expect(listForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: "all", labels: "evolution:auto" }));
    expect(parseFiledFingerprints(bodies)).toEqual(new Set(["c".repeat(64), "d".repeat(64)]));
  });

  it("through the real octokit gateway, a closed issue suppresses the re-file end to end", async () => {
    const [finding] = analyzeJobhunt(withSilent("ashby"), NOW).findings;
    listForRepo.mockImplementation(async (args: { state?: string }) => ({
      data: [{ number: 9, state: "closed", body: findingMarker(computeFingerprint(finding!)) }].filter(
        (i) => args.state === "all" || i.state === (args.state ?? "open"),
      ),
    }));

    const outcome = await runSelfImprovementDispatch(
      octokitIssueGateway("pushkarverma3698/FounderOS"),
      NOW,
      sourceOf([finding!]),
    );

    expect(outcome.state).toBe("all-filed");
    expect(createIssueApi).not.toHaveBeenCalled();
  });
});

describe("edge case: the dispatch loop is paused (quota, auth)", () => {
  it("the issue still files: filing reads only its own history, never the dispatcher's state", async () => {
    // A paused dispatcher leaves other issues at agent:blocked / agent:working. The
    // gateway has no way to ask about them, and filing must not depend on them.
    const paused = [
      { body: "hand-written issue stuck at agent:blocked", state: "open" as const },
      { body: "another one at agent:working", state: "open" as const },
    ];
    const { gateway, created, calls } = memoryGateway(paused);
    const { findings } = analyzeJobhunt(withSilent("ashby"), NOW);

    const outcome = await runSelfImprovementDispatch(gateway, NOW, sourceOf(findings));

    expect(outcome.state).toBe("filed");
    expect(created).toHaveLength(1);
    expect(created[0]!.labels).toContain("agent:ready");
    expect(calls).toEqual(["listAutoFiledBodies", "createIssue"]);
  });
});
