/**
 * Unit tests — the acting loop's orchestration and its founder-facing message.
 *
 * THE FAILURES THESE GUARD AGAINST.
 *  · Flooding. `agent-dispatch` spends a paid Antigravity invocation per claimed
 *    issue. More than one issue per run turns a tidiness backlog into a bill.
 *  · Duplicates. A finding that persists across audits filing a fresh issue every
 *    three days would bury the queue in copies of the same task.
 *  · A silent loop. Every branch must produce a message. "Nothing happened" and
 *    "the loop is broken" look identical from the outside otherwise — the exact
 *    way the 3-day audit was dead on prod for weeks while looking healthy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRunSelfAudit = vi.fn();
vi.mock("../../../src/evolution/run-audit.js", () => ({
  runSelfAudit: mockRunSelfAudit,
}));
vi.mock("../../../src/evolution/repo-root.js", () => ({
  repoRoot: () => "/repo",
}));

const {
  runSelfImprovementDispatch,
  parseFiledFingerprints,
  isDispatchEnabled,
  issueRepoSlug,
} = await import("../../../src/evolution/dispatch-findings.js");
const { renderDispatchMessage } = await import("../../../src/evolution/dispatch-message.js");
const { findingMarker } = await import("../../../src/evolution/issue-body.js");
const { computeFingerprint } = await import("../../../src/evolution/fingerprint.js");

import type { Finding } from "../../../src/evolution/types.js";
import type { IssueGateway } from "../../../src/evolution/dispatch-findings.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: "unused-dependency",
    subject: "left-pad",
    evidence: "left-pad is declared in package.json and imported nowhere under src/.",
    severity: "medium",
    ...overrides,
  };
}

function auditResult(ranked: readonly Finding[], telemetrySkippedReason: string | null = null) {
  return { staticResults: [], telemetryResults: [], telemetrySkippedReason, ranked };
}

function gateway(bodies: readonly string[] = []): IssueGateway & {
  createIssue: ReturnType<typeof vi.fn>;
} {
  const createIssue = vi.fn(async () => ({ number: 501, url: "https://github.com/x/y/issues/501" }));
  return { listAutoFiledBodies: async () => bodies, createIssue };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SELF_IMPROVE_DISPATCH_ENABLED"];
  delete process.env["SELF_IMPROVE_ISSUE_REPO"];
  delete process.env["GIT_COMMIT_SHA"];
});

afterEach(() => {
  delete process.env["SELF_IMPROVE_DISPATCH_ENABLED"];
  delete process.env["SELF_IMPROVE_ISSUE_REPO"];
});

describe("configuration", () => {
  it("is ON by default — a self-improvement loop that ships disabled does nothing", () => {
    expect(isDispatchEnabled()).toBe(true);
  });

  it("is off only for the exact string 'false'", () => {
    process.env["SELF_IMPROVE_DISPATCH_ENABLED"] = "false";
    expect(isDispatchEnabled()).toBe(false);
    process.env["SELF_IMPROVE_DISPATCH_ENABLED"] = "true";
    expect(isDispatchEnabled()).toBe(true);
  });

  it("defaults to the repo the VPS agent-dispatch cron watches", () => {
    // A mismatch here files issues somewhere nothing ever claims them, silently.
    expect(issueRepoSlug()).toBe("pushkarverma3698/FounderOS");
  });
});

describe("parseFiledFingerprints", () => {
  it("reads back the marker renderIssueBody writes", () => {
    const fp = "b".repeat(64);
    expect(parseFiledFingerprints([`some text\n${findingMarker(fp)}\nmore`])).toEqual(new Set([fp]));
  });

  it("ignores bodies without a marker, including empty ones", () => {
    expect(parseFiledFingerprints(["", "a hand-written issue"]).size).toBe(0);
  });

  it("is case-insensitive on the hex, since GitHub round-trips body text", () => {
    const fp = "c".repeat(64);
    expect(parseFiledFingerprints([findingMarker(fp.toUpperCase())]).has(fp)).toBe(true);
  });
});

describe("runSelfImprovementDispatch", () => {
  it("files exactly ONE issue even when many findings are dispatchable", async () => {
    const many = Array.from({ length: 20 }, (_, i) => finding({ subject: `pkg-${i}` }));
    mockRunSelfAudit.mockResolvedValue(auditResult(many));
    const gw = gateway();

    const outcome = await runSelfImprovementDispatch(gw);

    expect(gw.createIssue).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe("filed");
  });

  it("applies both labels — the dedupe label and the dispatcher's intake gate", async () => {
    mockRunSelfAudit.mockResolvedValue(auditResult([finding()]));
    const gw = gateway();

    await runSelfImprovementDispatch(gw);

    const [{ labels }] = gw.createIssue.mock.calls[0] as [{ labels: string[] }];
    expect(labels).toEqual(["evolution:auto", "agent:ready"]);
  });

  it("does not re-file a finding that already has an issue", async () => {
    const persistent = finding();
    mockRunSelfAudit.mockResolvedValue(auditResult([persistent]));
    const gw = gateway([findingMarker(computeFingerprint(persistent))]);

    const outcome = await runSelfImprovementDispatch(gw);

    expect(gw.createIssue).not.toHaveBeenCalled();
    expect(outcome.state).toBe("all-filed");
  });

  it("distinguishes 'nothing worth dispatching' from 'everything already filed'", async () => {
    // These are different situations and the founder needs to tell them apart:
    // one means the audit found only decisions, the other means the executor
    // queue is the bottleneck.
    mockRunSelfAudit.mockResolvedValue(
      auditResult([finding({ kind: "cost-hotspot" }), finding({ kind: "dead-export" })]),
    );

    const outcome = await runSelfImprovementDispatch(gateway());

    expect(outcome).toEqual({ state: "nothing-dispatchable", totalFindings: 2 });
  });

  it("files nothing at all when the kill switch is off, and does not even run the audit", async () => {
    process.env["SELF_IMPROVE_DISPATCH_ENABLED"] = "false";
    const gw = gateway();

    const outcome = await runSelfImprovementDispatch(gw);

    expect(outcome).toEqual({ state: "disabled" });
    expect(mockRunSelfAudit).not.toHaveBeenCalled();
    expect(gw.createIssue).not.toHaveBeenCalled();
  });

  it("still dispatches from static findings when the telemetry tier went dark", async () => {
    // A dead Postgres must not stop the loop — it only narrows what it can see,
    // and Loop A's message is what tells the founder the tier was blind.
    mockRunSelfAudit.mockResolvedValue(auditResult([finding()], "connect ECONNREFUSED"));

    const outcome = await runSelfImprovementDispatch(gateway());

    expect(outcome.state).toBe("filed");
  });

  it("stamps the issue with the commit the finding was detected at", async () => {
    process.env["GIT_COMMIT_SHA"] = "8a5b9a3";
    mockRunSelfAudit.mockResolvedValue(auditResult([finding()]));
    const gw = gateway();

    await runSelfImprovementDispatch(gw);

    const [{ body }] = gw.createIssue.mock.calls[0] as [{ body: string }];
    expect(body).toContain("8a5b9a3");
  });

  it("propagates a GitHub failure instead of reporting a clean run", async () => {
    mockRunSelfAudit.mockResolvedValue(auditResult([finding()]));
    const gw = gateway();
    gw.createIssue.mockRejectedValue(new Error("403 rate limited"));

    await expect(runSelfImprovementDispatch(gw)).rejects.toThrow("403 rate limited");
  });
});

describe("renderDispatchMessage", () => {
  it("produces a message for every outcome state — the loop is never silent", () => {
    const outcomes = [
      { state: "disabled" },
      { state: "nothing-dispatchable", totalFindings: 3 },
      { state: "all-filed", dispatchableCount: 4 },
      { state: "filed", finding: finding(), fingerprint: "a".repeat(64), issueNumber: 501, url: "https://x/501" },
      { state: "failed", reason: "GITHUB_TOKEN is not set" },
    ] as const;

    for (const outcome of outcomes) {
      const message = renderDispatchMessage(outcome);
      expect(message.length).toBeGreaterThan(40);
    }
  });

  it("escapes finding text, which routinely contains angle brackets", () => {
    // normalizeFailureSignature writes <n>, <uuid>, <url> into signatures on
    // purpose. Telegram 400s on an unknown tag, and the send used to fail whole.
    const message = renderDispatchMessage({
      state: "filed",
      finding: finding({ subject: "worker:timeout after <n>ms at <url>" }),
      fingerprint: "a".repeat(64),
      issueNumber: 501,
      url: "https://x/501",
    });

    expect(message).toContain("&lt;n&gt;ms at &lt;url&gt;");
    expect(message).not.toMatch(/<n>|<url>/);
  });

  it("a filed issue tells the founder the ONE thing only they can do", () => {
    const message = renderDispatchMessage({
      state: "filed",
      finding: finding(),
      fingerprint: "a".repeat(64),
      issueNumber: 501,
      url: "https://x/501",
    });

    expect(message).toContain("#501");
    expect(message).toMatch(/You only act at the merge/);
    expect(message).toMatch(/--remove-label agent:ready/);
  });

  it("a failure says no issue was filed rather than implying a clean run", () => {
    const message = renderDispatchMessage({ state: "failed", reason: "boom" });
    expect(message).toContain("FAILED");
    expect(message).toMatch(/No issue was filed/);
  });
});
