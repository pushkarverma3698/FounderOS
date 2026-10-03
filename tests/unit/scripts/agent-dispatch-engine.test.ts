/**
 * agent-dispatch runs the coding CLI the task names — deploy/agent-dispatch, deploy/lib/engine.sh, deploy/lib/claude-run.sh.
 * ==========================================================================================================================
 * Until now the executor was Antigravity, hard-wired. The founder can now send a task to Claude Code (`/claude`), to
 * Antigravity (`/agy`), or switch the default (`/engine`); the loop (issue -> executor -> draft PR -> review) runs the same
 * way for either. What these pin, from the outside, against the real script and the shared sandbox:
 *
 *   - WHICH CLI runs: the issue's `engine:*` label, else the default file, else agy; an agent:review issue with no label
 *     predates the switch, so it goes back to agy whatever the default is.
 *   - THE TOKEN never reaches a command line, a log, a Telegram message or a state file: it travels on stdin.
 *   - ONE CLI's wall stops ONE CLI. Claude's weekly limit (exit 0!), a token it refuses, or a missing token blocks claude
 *     only; agy keeps working. And agy's own pause (login, quota) does not stop claude. A wall costs one message, not one
 *     per tick, and the issue goes back to agent:ready (it did nothing wrong).
 *   - Gates that are not about one CLI (gh logged out) still stop both.
 *
 * Stream fixtures are in claude-streams.ts, with their provenance. The claude success path is NOT VERIFIED against a live
 * Claude: no logged-in one was available when this was written.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, utimesSync } from "node:fs";
import { DispatchSandbox, FAKE_CLAUDE_TOKEN, FAKE_GEMINI_KEY } from "./dispatch-sandbox.js";
import { weeklyLimitStream, NOT_LOGGED_IN_STREAM, BAD_TOKEN_STREAM, WORKING_STREAM } from "./claude-streams.js";

const REPO = "owner/founderos";
const BLOCKED = "agent-dispatch.claude-blocked";
const AGY_AUTH_LINE = "error: authentication failed or timed out"; // [verbatim] agy with no login, 2026-10-02
/** The executor's work: a commit on the branch the daemon checked out, and a draft PR from it. */
const OPEN_A_PR =
  'git -c user.name=t -c user.email=t@t commit --allow-empty -q -m "work" && gh pr create --repo owner/founderos --head "$(git branch --show-current)" --title t --body b >/dev/null';
const CI_RED = { name: "Unit + regression tests", bucket: "fail", state: "FAILURE" } as const;

let sb: DispatchSandbox;
const inTwoDays = (): number => Math.floor(Date.now() / 1000) + 2 * 86400 + 3600;
const humanUtc = (epoch: number): string => `${new Date(epoch * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const blockLines = (): string[] => sb.readState(BLOCKED).split("\n");

beforeEach(() => {
  sb = new DispatchSandbox([REPO]);
  sb.writeClaudeToken();
});

afterEach(() => {
  sb.destroy();
});

describe("which CLI runs", () => {
  it("an engine:claude issue runs claude, and not agy", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(0);
    expect(sb.labelsOf(710)).toEqual(expect.arrayContaining(["agent:review"]));
    expect(sb.prs()).toHaveLength(1);
  });

  it("an engine:agy issue runs agy, and not claude", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.claudeRuns()).toBe(0);
  });

  it("an unlabelled issue uses the default file", () => {
    sb.addIssue({ number: 710 });
    sb.setDefaultEngine("claude");

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(0);
  });

  it.each([
    ["no default file", undefined],
    ["a default file of agy", "agy"],
    ["a default file holding junk", "gemini-please"],
    ["an empty default file", ""],
  ] as const)("an unlabelled issue runs agy with %s", (_what, content) => {
    sb.addIssue({ number: 710 });
    if (content !== undefined) sb.setDefaultEngine(content);

    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.claudeRuns()).toBe(0);
  });

  it("the issue's label beats the default file", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:agy"] });
    sb.setDefaultEngine("claude");

    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.claudeRuns()).toBe(0);
  });

  it("both labels on one issue is ambiguous: the default decides, the daemon does not guess", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:agy", "engine:claude"] });
    sb.setDefaultEngine("claude");
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });
    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(0);
  });

  it("an agent:ready queue is served oldest first, each issue by its own CLI, one claim per tick", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:agy"] });
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR, claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.claudeRuns()).toBe(0);
    expect(sb.labelsOf(711)).toContain("agent:ready");
  });
});

describe("what the run is told, and what it must never see", () => {
  it("runs claude non-interactively with the stream format the progress view reads, on the configured model", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    const argv = sb.claudeArgv();
    expect(argv).toMatch(/--dangerously-skip-permissions/);
    expect(argv).toMatch(/--output-format stream-json/);
    expect(argv).toMatch(/--verbose/);
    expect(argv).toMatch(/--model sonnet/);
    expect(sb.claudePrompts()[0]).toMatch(/#710/);
  });

  it("the model is configurable", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR, env: { AGENT_DISPATCH_CLAUDE_MODEL: "opus" } });
    expect(sb.claudeArgv()).toMatch(/--model opus/);
  });

  it("the token reaches claude's ENVIRONMENT and nothing else: not argv, not sudo's argv, not a log, not Telegram, not a state file", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    // claude echoes the token it was handed: the worst case for the log and the progress message.
    sb.tick({ claudeOut: `${WORKING_STREAM}\nError: rejected ${FAKE_CLAUDE_TOKEN}`, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeTokensSeen()).toEqual([FAKE_CLAUDE_TOKEN]);
    expect(sb.claudeArgv()).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(sb.sudoCalls().join("\n")).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(sb.ghLog()).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(sb.log()).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(sb.telegram().map((c) => c.text).join("\n")).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(sb.allStateText()).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(sb.daemonText()).not.toContain(FAKE_CLAUDE_TOKEN);
  });

  it("the Gemini key is not handed to claude, and the Claude token is not handed to agy", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });
    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    expect(sb.claudeArgv()).not.toContain(FAKE_GEMINI_KEY);
    expect(sb.agyKeysSeen().join("\n")).not.toContain(FAKE_CLAUDE_TOKEN);
  });

  it("tells the founder which CLI wrote the PR, by name", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    const opened = sb.messages().find((m) => /PR #\d+ opened/.test(m)) ?? "";
    expect(opened).toMatch(/Claude Code/);
    expect(opened).not.toMatch(/Antigravity/);
  });

  it("keeps saying Antigravity for an agy run (the existing messages do not change)", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    const opened = sb.messages().find((m) => /PR #\d+ opened/.test(m)) ?? "";
    expect(opened).toMatch(/Antigravity/);
    expect(opened).not.toMatch(/Claude Code/);
  });
});

describe("the issue and its PR carry the engine, so the next pass knows who wrote it", () => {
  it.each([
    ["claude", { claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR }],
    ["agy", { agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR }],
  ] as const)("a %s run labels the PR and the issue with its engine, whichever way the engine was chosen", (engine, tickOpts) => {
    sb.addIssue({ number: 710 }); // unlabelled: chosen by the default file
    sb.setDefaultEngine(engine);

    sb.tick(tickOpts);

    expect(sb.prs()).toHaveLength(1);
    expect(sb.prLabelsOf(sb.prs()[0]?.number ?? 0)).toContain(`engine:${engine}`);
    expect(sb.labelsOf(710)).toContain(`engine:${engine}`);
    // `gh pr edit --add-label` and `gh issue edit --add-label` fail on a label the repo does not have yet; the API route creates it.
    expect(sb.ghLog()).not.toMatch(/--add-label engine:/);
  });

  it("does not add the label to the PR a second time when the issue already carries it", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });
    expect(sb.labelsOf(710).filter((l) => l === "engine:claude")).toHaveLength(1);
  });
});

describe("Claude is out of token: the founder has not run `claude setup-token`", () => {
  beforeEach(() => {
    rmSync(sb.claudeTokenPath(), { force: true });
  });

  it("runs nothing, leaves the issue queued (not failed), and says what to do, once", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick();
    sb.tick();
    sb.tick();

    expect(sb.claudeRuns()).toBe(0);
    expect(sb.labelsOf(710)).toEqual(["agent:ready", "engine:claude"]);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toMatch(/claude setup-token/);
    expect(sb.messages()[0]).toContain("claude-code.token");
    expect(sb.hasState("agent-dispatch.down")).toBe(false);
  });

  it("an agy issue queued behind it is not held up", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.labelsOf(711)).toContain("agent:review");
    expect(sb.labelsOf(710)).toContain("agent:ready");
  });

  it("runs the moment the token file appears", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.tick();
    expect(sb.claudeRuns()).toBe(0);

    sb.writeClaudeToken();
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.labelsOf(710)).toContain("agent:review");
  });

  it("an empty token file is the same as none", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    writeFileSync(sb.claudeTokenPath(), "\n", { mode: 0o600 });

    sb.tick();

    expect(sb.claudeRuns()).toBe(0);
    expect(sb.messages()[0]).toMatch(/claude setup-token/);
  });
});

describe("Claude's weekly limit [stream shape captured; exit 0]", () => {
  it("puts the issue back to agent:ready, blocks claude until the reset the CLI reported, and tells the founder once", () => {
    const resetsAt = inTwoDays();
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: weeklyLimitStream(resetsAt), claudeRc: 0 });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.labelsOf(710)).toContain("agent:ready");
    expect(sb.labelsOf(710)).not.toContain("agent:failed");
    expect(sb.labelsOf(710)).not.toContain("agent:working");
    expect(blockLines().slice(0, 2)).toEqual(["quota", String(resetsAt)]);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toMatch(/Claude Code/);
    expect(sb.messages()[0]).toMatch(/weekly limit/);
    expect(sb.messages()[0]).toContain(humanUtc(resetsAt));
    expect(sb.messages()[0]).toMatch(/Antigravity .*keep|agy .*keep|keeps? running/i);
  });

  it("claude's wall is not agy's: no global pause, no agy quota file", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: weeklyLimitStream(inTwoDays()), claudeRc: 0 });

    expect(sb.hasState("agent-dispatch.down")).toBe(false);
    expect(sb.hasState("agent-dispatch.quota-until")).toBe(false);
  });

  it("does not run claude again, or say anything again, until the reset", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.tick({ claudeOut: weeklyLimitStream(inTwoDays()), claudeRc: 0 });
    sb.tick({ claudeOut: weeklyLimitStream(inTwoDays()), claudeRc: 0 });
    sb.tick({ claudeOut: weeklyLimitStream(inTwoDays()), claudeRc: 0 });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.log()).toMatch(/Claude Code blocked \(quota\) until/);
  });

  it("agy keeps working while claude is blocked: in the same tick, and in the next", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ claudeOut: weeklyLimitStream(inTwoDays()), claudeRc: 0, agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(1);
    expect(sb.labelsOf(711)).toContain("agent:review");
    expect(sb.labelsOf(710)).toContain("agent:ready");
  });

  it("runs claude again once the recorded reset has passed", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    writeFileSync(sb.statePath(BLOCKED), `quota\n${Math.floor(Date.now() / 1000) - 60}\nweekly limit\n`);

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.hasState(BLOCKED)).toBe(false);
  });

  it("a limit with no reset time backs off one hour, not forever and not zero", () => {
    const noReset = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your weekly limit","api_error_status":429}',
    ].join("\n");
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: noReset, claudeRc: 0 });

    expect(blockLines()[0]).toBe("quota");
    expect(Math.abs(Number(blockLines()[1]) - (Date.now() / 1000 + 3600))).toBeLessThan(120);
    expect(sb.labelsOf(710)).not.toContain("agent:failed");
  });

  it("a warning that the limit is near (status allowed_warning) is not a failure", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.hasState(BLOCKED)).toBe(false);
    expect(sb.labelsOf(710)).toContain("agent:review");
  });
});

describe("Claude's token is refused [stream text captured]", () => {
  it.each([
    ["not logged in", NOT_LOGGED_IN_STREAM, 1, /Not logged in/],
    ["a rejected token", BAD_TOKEN_STREAM, 1, /OAuth access token is invalid/],
  ] as const)("%s: issue back to agent:ready, claude blocked, ONE message quoting the CLI, nobody else paused", (_what, stream, rc, quoted) => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: stream, claudeRc: rc });
    sb.tick({ claudeOut: stream, claudeRc: rc });
    sb.tick({ claudeOut: stream, claudeRc: rc });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.labelsOf(710)).toContain("agent:ready");
    expect(sb.labelsOf(710)).not.toContain("agent:failed");
    expect(blockLines()[0]).toBe("auth");
    expect(sb.hasState("agent-dispatch.down")).toBe(false);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toMatch(quoted);
    expect(sb.messages()[0]).toMatch(/claude setup-token/);
    expect(sb.messages()[0]).toMatch(/engine:agy/); // how to run the queued work on the other CLI meanwhile
    expect(sb.commentsOf(710).join("\n")).toMatch(quoted);
  });

  it("runs again when the token file changes, and not before", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.tick({ claudeOut: BAD_TOKEN_STREAM, claudeRc: 1 });
    sb.tick({ claudeOut: BAD_TOKEN_STREAM, claudeRc: 1 });
    expect(sb.claudeRuns()).toBe(1);

    const t = Math.floor(Date.now() / 1000) - 30; // the token was written at now-3600
    utimesSync(sb.claudeTokenPath(), t, t);
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(2);
    expect(sb.hasState(BLOCKED)).toBe(false);
    expect(sb.labelsOf(710)).toContain("agent:review");
  });

  it("a token pasted while the run was still failing on the old one is tried on the next tick", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    const d = new Date(Date.now() - 30_000);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
    // the file changes DURING the run: the block must be recorded against the mtime from before it
    sb.tick({ claudeOut: BAD_TOKEN_STREAM, claudeRc: 1, claudeHook: `touch -t ${stamp} "${sb.claudeTokenPath()}"` });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR });

    expect(sb.claudeRuns()).toBe(2);
  });

  it("the quoted line is redacted: a token the CLI echoed back is not sent to Telegram or GitHub", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    const echoed = `${BAD_TOKEN_STREAM}\nError: Failed to authenticate with ${FAKE_CLAUDE_TOKEN}`;

    sb.tick({ claudeOut: echoed, claudeRc: 1 });

    const everywhere = [sb.messages().join("\n"), sb.commentsOf(710).join("\n"), sb.log(), sb.allStateText()].join("\n");
    expect(everywhere).not.toContain(FAKE_CLAUDE_TOKEN);
  });

  it("an ordinary claude failure is still agent:failed, and blocks nothing", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: "Error: something else broke", claudeRc: 1 });

    expect(sb.labelsOf(710)).toContain("agent:failed");
    expect(sb.hasState(BLOCKED)).toBe(false);
  });

  it("a transient claude failure puts the issue back to the queue without blocking claude", () => {
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });

    sb.tick({ claudeOut: "Error: read ECONNRESET", claudeRc: 1 });

    expect(sb.labelsOf(710)).toContain("agent:ready");
    expect(sb.labelsOf(710)).not.toContain("agent:failed");
    expect(sb.hasState(BLOCKED)).toBe(false);
  });
});

describe("one CLI's wall does not stop the other", () => {
  it("agy's login is rejected: agy is paused (as before), claude still runs", () => {
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });
    sb.tick({ agyOut: AGY_AUTH_LINE, agyRc: 1 });
    expect(sb.readState("agent-dispatch.down").split("\n")[0]).toBe("auth");
    expect(sb.agyRuns()).toBe(1);

    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR, agyOut: "done", agyRc: 0 });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(1); // still the one run from before: agy stays paused
    expect(sb.labelsOf(710)).toContain("agent:review");
    expect(sb.labelsOf(711)).toContain("agent:ready");
    expect(sb.readState("agent-dispatch.down").split("\n")[0]).toBe("auth");
  });

  it("agy's quota wall stops agy only", () => {
    writeFileSync(sb.statePath("agent-dispatch.quota-until"), `${Math.floor(Date.now() / 1000) + 3 * 3600}\n`);
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, claudeHook: OPEN_A_PR, agyOut: "done", agyRc: 0 });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(0);
  });

  it("agy still hits its own quota wall and records it where it always did, whatever claude's state is", () => {
    writeFileSync(sb.statePath(BLOCKED), `quota\n${Math.floor(Date.now() / 1000) + 86400}\nweekly limit\n`);
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ agyOut: "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s." });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.hasState("agent-dispatch.quota-until")).toBe(true);
    expect(sb.labelsOf(711)).toContain("agent:ready");
  });

  it("a gate that is not about one CLI (gh logged out) still stops both", () => {
    sb.patchGh({ authOk: false });
    sb.addIssue({ number: 710, labels: ["agent:ready", "engine:claude"] });
    sb.addIssue({ number: 711, labels: ["agent:ready", "engine:agy"] });

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, agyOut: "done", agyRc: 0 });

    expect(sb.claudeRuns()).toBe(0);
    expect(sb.agyRuns()).toBe(0);
    expect(sb.readState("agent-dispatch.down").split("\n")[0]).toBe("gh-auth");
  });
});

describe("Pass B: re-dispatching a draft PR the reviewer left, or whose CI is red", () => {
  const BRANCH = "task/issue-713-fix-needs-a-second-pass";

  const setup = (issueLabels: readonly string[]): void => {
    sb.addIssue({ number: 710, title: "parked", labels: ["agent:working"] });
    sb.ensureRemoteBranch(REPO, BRANCH);
    sb.addIssue({ number: 713, title: "fix: needs a second pass", labels: issueLabels });
    sb.addPr({ number: 56, headRefName: BRANCH, headRefOid: "a".repeat(40), isDraft: true, checks: [CI_RED] });
  };
  const attempts = (): string[] => sb.prCommentsOf(56, REPO).filter((c) => c.startsWith("<!-- agent-attempt:"));

  it("an engine:claude issue is sent back to claude, which is named in the attempt note", () => {
    setup(["agent:review", "engine:claude"]);

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0 });

    expect(sb.claudeRuns()).toBe(1);
    expect(sb.agyRuns()).toBe(0);
    expect(sb.claudePrompts()[0]).toMatch(/FAILING CI check, not a review finding/);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatch(/Claude Code/);
  });

  it("an issue with no engine label predates the switch: agy, whatever the default is now", () => {
    setup(["agent:review"]);
    sb.setDefaultEngine("claude");

    sb.tick({ agyOut: "done", agyRc: 0, claudeOut: WORKING_STREAM, claudeRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.claudeRuns()).toBe(0);
    expect(attempts()[0]).toMatch(/Antigravity/);
  });

  it("an engine:agy issue goes to agy", () => {
    setup(["agent:review", "engine:agy"]);
    sb.setDefaultEngine("claude");

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.claudeRuns()).toBe(0);
  });

  it("while claude is blocked nothing is run and the attempt is not counted", () => {
    setup(["agent:review", "engine:claude"]);
    writeFileSync(sb.statePath(BLOCKED), `quota\n${Math.floor(Date.now() / 1000) + 86400}\nweekly limit\n`);

    sb.tick({ claudeOut: WORKING_STREAM, claudeRc: 0, agyOut: "done", agyRc: 0 });

    expect(sb.claudeRuns()).toBe(0);
    expect(sb.agyRuns()).toBe(0);
    expect(attempts()).toHaveLength(0);
    expect(sb.labelsOf(713)).toContain("agent:review");
  });

  it("hitting the weekly limit mid re-dispatch blocks claude, leaves the PR open and does not count the attempt", () => {
    setup(["agent:review", "engine:claude"]);
    const resetsAt = inTwoDays();

    sb.tick({ claudeOut: weeklyLimitStream(resetsAt), claudeRc: 0 });

    expect(sb.claudeRuns()).toBe(1);
    expect(blockLines().slice(0, 2)).toEqual(["quota", String(resetsAt)]);
    expect(attempts()).toHaveLength(0);
    expect(sb.labelsOf(713)).toContain("agent:review");
    expect(sb.labelsOf(713)).not.toContain("agent:blocked");
    expect(sb.messages()).toHaveLength(1);
  });

  it("a refused token mid re-dispatch blocks claude, leaves the PR open and does not count the attempt", () => {
    setup(["agent:review", "engine:claude"]);

    sb.tick({ claudeOut: BAD_TOKEN_STREAM, claudeRc: 1 });

    expect(blockLines()[0]).toBe("auth");
    expect(attempts()).toHaveLength(0);
    expect(sb.hasState("agent-dispatch.down")).toBe(false);
    expect(sb.messages()).toHaveLength(1);
  });
});
