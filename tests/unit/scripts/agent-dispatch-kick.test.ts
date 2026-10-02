/**
 * The bot's kick, the PR target branch, and finished reviews — deploy/agent-dispatch.
 * ===================================================================================
 * Three things the 2026-10-02 /task session got wrong, each pinned here by what the founder felt.
 *
 * 1. THE KICK. Approving a /task paused the whole loop with "🛑 agent-dispatch PAUSED: the Antigravity CLI
 *    (agy) is not on the PATH", three times in one afternoon, and then "✅ resumed". The bot started the
 *    dispatcher itself, under systemd's NoNewPrivileges, where every `sudo` fails: the startup check read
 *    that as "agy is gone". The bot now leaves a note, and `agent-dispatch --kicked` (a per-minute cron
 *    job) turns it into a tick. The property pinned: a kick starts a tick within a minute, a minute with no
 *    kick costs and says nothing, and a kick is never lost to a running tick or spent on a dead loop twice.
 *
 * 2. THE TARGET BRANCH. The daemon asked the workspace whether the repo has a beta branch. The workspace is
 *    mode 750 for the antigravity user, so the question failed with "Permission denied", read as "no beta",
 *    and every task was cut from main with a brief saying "open the PR targeting main" (PR #789 did).
 *
 * 3. FINISHED REVIEWS. Nothing ever took agent:review off an issue whose PR had merged, so the /tasks board
 *    listed finished work as "in review" (#669 and #670 sat there for weeks).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const REPO = "owner/founderos";
const BRANCH = "task/issue-710-test-docs-add-visible-test-comment";

let sb: DispatchSandbox;

beforeEach(() => {
  sb = new DispatchSandbox([REPO]);
  sb.addIssue({ number: 710, title: "test(docs): add visible test comment" });
});

afterEach(() => {
  sb.destroy();
});

const kick = (text = `${REPO}#710\n`): void => writeFileSync(sb.statePath("agent-dispatch.kick"), text);

describe("agent-dispatch --kicked (the per-minute cron job)", () => {
  it("with no kick note it exits 0 having done NOTHING: no log line, no gh call, no Telegram, no agy", () => {
    const r = sb.tick({ args: ["--kicked"] });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(sb.log()).toBe("");
    expect(sb.ghCallList()).toEqual([]);
    expect(sb.telegram()).toEqual([]);
    expect(sb.agyRuns()).toBe(0);
  });

  it("an empty kick file is no kick", () => {
    kick("");
    const r = sb.tick({ args: ["--kicked"] });

    expect(r.stdout).toBe("");
    expect(sb.agyRuns()).toBe(0);
  });

  it("a kick note starts an ordinary tick: the issue is claimed and Antigravity runs, and the note is spent", () => {
    kick();
    const r = sb.tick({ args: ["--kicked"], agyOut: "Error: something else broke" });

    expect(r.status).toBe(0);
    expect(sb.agyRuns()).toBe(1);
    expect(sb.log()).toContain(`kicked by the bot for: ${REPO}#710`);
    expect(sb.log()).toMatch(/claiming #710/);
    expect(sb.hasState("agent-dispatch.kick")).toBe(false);
  });

  it("a tick that is already running leaves the note where it is, silently: a kick during a 30-minute run is not lost", () => {
    kick();
    mkdirSync(sb.statePath("agent-dispatch.lock"));

    const r = sb.tick({ args: ["--kicked"] });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(sb.log()).toBe("");
    expect(sb.hasState("agent-dispatch.kick")).toBe(true);
    expect(sb.agyRuns()).toBe(0);
  });

  it("the 15-minute cron tick also spends a waiting note, so it does not start a second tick a minute later", () => {
    kick();
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.hasState("agent-dispatch.kick")).toBe(false);
  });

  it("the kill switch spends the note too, or the per-minute job would log it every minute", () => {
    kick();
    writeFileSync(sb.statePath("agent-dispatch.off"), "");

    const r = sb.tick({ args: ["--kicked"] });

    expect(r.status).toBe(0);
    expect(sb.log().match(/kill switch present/g)).toHaveLength(1);
    expect(sb.hasState("agent-dispatch.kick")).toBe(false);
    expect(sb.tick({ args: ["--kicked"] }).stdout).toBe("");
  });

  it("a loop that cannot start (gh logged out) is announced ONCE and the note is spent: no check, no log, every minute", () => {
    sb.patchGh({ authOk: false });
    kick();

    sb.tick({ args: ["--kicked"] });
    const second = sb.tick({ args: ["--kicked"] });
    const third = sb.tick({ args: ["--kicked"] });

    expect(sb.messages().filter((m) => m.includes("PAUSED"))).toHaveLength(1);
    expect(sb.hasState("agent-dispatch.kick")).toBe(false);
    expect(second.stdout).toBe("");
    expect(third.stdout).toBe("");
  });

  it("is what the approved-/task flow needs: the issue is claimed by --kicked without ever calling sudo for a startup check that can fail", () => {
    // The old kick ran `agent-dispatch --issue N --repo R` from the bot. Here the bot's only act is the note.
    kick();
    sb.tick({ args: ["--kicked"], agyOut: "Error: something else broke" });

    expect(sb.messages().filter((m) => m.includes("PAUSED"))).toEqual([]);
    expect(sb.hasState("agent-dispatch.down")).toBe(false);
  });
});

describe("the branch a task is cut from and its PR targets", () => {
  const PROMPT_TARGET = /Open the PR as a draft targeting (\w+)/;
  const checkout = (): string => sb.sudoCalls().find((c) => c.includes("git reset --hard")) ?? "";

  it("is beta when GitHub says the repo has a beta branch, even though the workspace is unreadable to this user", () => {
    sb.addBetaBranch(REPO);
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.agyPrompts()[0]).toMatch(/checked out from origin\/beta/);
    expect(sb.agyPrompts()[0]?.match(PROMPT_TARGET)?.[1]).toBe("beta");
    expect(checkout()).toMatch(new RegExp(`${BRANCH} beta$`));
  });

  it("is main when the repo has no beta (a definite 404)", () => {
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.agyPrompts()[0]?.match(PROMPT_TARGET)?.[1]).toBe("main");
    expect(checkout()).toMatch(new RegExp(`${BRANCH} main$`));
    expect(sb.log()).not.toMatch(/could not tell whether/);
  });

  it("is main, and the log SAYS it could not tell, when GitHub is down: an outage is not a 404", () => {
    sb.patchGh({ failApi: true });
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.agyPrompts()[0]?.match(PROMPT_TARGET)?.[1]).toBe("main");
    expect(sb.log()).toMatch(/could not tell whether owner\/founderos has a beta branch \(HTTP 502/);
  });

  it("asks GitHub, never the workspace: no git -C against the antigravity-owned directory", () => {
    sb.addBetaBranch(REPO);
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.ghLog()).toMatch(/api repos\/owner\/founderos\/branches\/beta/);
  });
});

/** Issue 710 (ready, from the top-level setup) would be claimed first and run a second agy: park it. */
const parkIssue710 = (): void => sb.addIssue({ number: 710, title: "parked", labels: [] });

describe("an issue whose PR is no longer open is not 'in review'", () => {
  const LINK = (pr: number): string => `<!-- agent-pr: ${pr} --> PR opened: https://github.com/${REPO}/pull/${pr}. Awaiting pr-brain review.`;

  beforeEach(() => {
    parkIssue710();
    sb.addIssue({ number: 711, title: "docs: a finished task", labels: ["agent:review"], comments: [LINK(55)] });
  });

  it("MERGED: the label comes off, the issue is closed, one comment says why, and nobody is messaged", () => {
    sb.addPr({ number: 55, headRefName: "task/issue-711-docs-a-finished-task", state: "MERGED", isDraft: false });

    sb.tick({ agyOut: "" });

    expect(sb.labelsOf(711)).toEqual([]);
    expect(sb.issue(711).state).toBe("closed");
    expect(sb.commentsOf(711).at(-1)).toMatch(/PR #55 is merged, so this issue is done/);
    expect(sb.messages().filter((m) => m.includes("#711"))).toEqual([]);
  });

  it("CLOSED unmerged: the label comes off and the issue stays OPEN, for the founder to decide", () => {
    sb.addPr({ number: 55, headRefName: "task/issue-711-docs-a-finished-task", state: "CLOSED", isDraft: true });

    sb.tick({ agyOut: "" });

    expect(sb.labelsOf(711)).toEqual([]);
    expect(sb.issue(711).state).toBe("open");
    expect(sb.commentsOf(711).at(-1)).toMatch(/PR #55 was closed without merging/);
  });

  it("an issue with no PR link comment is left alone: nothing here can say what happened to it", () => {
    sb.addIssue({ number: 712, title: "docs: no link", labels: ["agent:review"], comments: ["unrelated"] });

    sb.tick({ agyOut: "" });

    expect(sb.labelsOf(712)).toEqual(["agent:review"]);
    expect(sb.issue(712).state).toBe("open");
  });

  it("an OPEN PR is never touched by this path (the review/re-dispatch logic owns it)", () => {
    sb.addPr({ number: 55, headRefName: "task/issue-711-docs-a-finished-task", state: "OPEN", isDraft: true });

    sb.tick({ agyOut: "" });

    expect(sb.labelsOf(711)).toEqual(["agent:review"]);
    expect(sb.issue(711).state).toBe("open");
  });

  it("--dry-run only says what it would do", () => {
    sb.addPr({ number: 55, headRefName: "task/issue-711-docs-a-finished-task", state: "MERGED", isDraft: false });

    const r = sb.tick({ args: ["--dry-run"], agyOut: "" });

    expect(r.status).toBe(0);
    expect(sb.log()).toMatch(/DRY RUN would close #711: PR #55 is merged/);
    expect(sb.labelsOf(711)).toEqual(["agent:review"]);
    expect(sb.issue(711).state).toBe("open");
  });
});

describe("re-dispatch tells the founder what actually happened to the PR", () => {
  const HEAD = "a".repeat(40);
  const NEW_HEAD = "b".repeat(40);
  const SET_HEAD = `jq '.repos["${REPO}"].prs[0].headRefOid="${NEW_HEAD}"' "$GH_STATE" >"$GH_STATE.tmp" && mv "$GH_STATE.tmp" "$GH_STATE"`;

  beforeEach(() => {
    parkIssue710();
    sb.ensureRemoteBranch(REPO, "task/issue-713-fix-needs-a-second-pass");
    sb.addIssue({ number: 713, title: "fix: needs a second pass", labels: ["agent:review"], comments: [] });
    sb.addPr({
      number: 56,
      headRefName: "task/issue-713-fix-needs-a-second-pass",
      headRefOid: HEAD,
      isDraft: true,
      comments: [`<!-- brain-reviewed: ${HEAD} -->`],
    });
  });

  it("a run that moved the head says what it pushed", () => {
    sb.tick({ agyOut: "done", agyRc: 0, agyHook: SET_HEAD });

    expect(sb.messages().find((m) => m.includes("re-dispatched Antigravity on PR #56"))).toMatch(/pushed bbbbbbbb/);
  });

  it("a run that changed nothing SAYS so, instead of reporting a fix (it still counts as an attempt)", () => {
    sb.tick({ agyOut: "done", agyRc: 0 });

    const msg = sb.messages().find((m) => m.includes("re-dispatched Antigravity on PR #56")) ?? "";
    expect(msg).toMatch(/pushed NOTHING \(the head is still aaaaaaaa\)/);
    expect(sb.prCommentsOf(56, REPO).some((c) => c.startsWith("<!-- agent-attempt: 1"))).toBe(true);
  });

  it("the prompt names pr-brain as the reviewer, not a vendor", () => {
    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyPrompts()[0]).toMatch(/reviewed by pr-brain \(the independent reviewer\)/);
    expect(sb.agyPrompts()[0]).not.toMatch(/Claude/);
  });
});

describe("the daemon survives its own file being replaced while it runs", () => {
  it("the last line of the script is the single call, so nothing is read after the first claim", () => {
    // A running bash script reads its file by byte offset. scp and `cat >` rewrite it in place; the
    // 2026-10-02 16:39 tick died with "d_reviews: command not found" halfway through the old tail.
    const lines = sb.daemonText().trimEnd().split("\n");
    expect(lines.at(-1)).toBe("run_tick; exit $?");
    // `run_tick() {` is the definition; a bare call anywhere above the last line would run before the file is parsed.
    expect(lines.slice(0, -1).some((l) => /^run_tick(;| |$)/.test(l))).toBe(false);
  });

  it("really survives it: overwrite the daemon in place while a tick is in the middle of agy", () => {
    // The fake agy overwrites the running script in place (same inode, like scp) with a different, longer,
    // broken file, then exits. A daemon that read its tail afterwards would die on the garbage.
    const target = sb.daemonPath();
    const hook = `printf 'echo REPLACED; garbage ((( \\n' >>"${target}"; head -c 300 /dev/urandom | base64 >>"${target}"`;

    const r = sb.tick({ agyOut: "Error: something else broke", agyHook: hook });

    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/REPLACED|command not found|syntax error/);
    // (the sandbox's login shells print "/etc/profile: line 21: run-parts: command not found": not ours)
    expect(r.stderr.split("\n").filter((l) => !l.includes("/etc/profile")).join("\n")).not.toMatch(/command not found|syntax error/);
    expect(sb.log()).toMatch(/tick complete/);
    expect(existsSync(target)).toBe(true);
  });
});
