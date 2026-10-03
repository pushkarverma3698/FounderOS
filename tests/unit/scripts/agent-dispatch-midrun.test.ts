/**
 * What happens when the world changes while Antigravity is running — deploy/agent-dispatch.
 * ==========================================================================================
 * A run can last 30 minutes. In that time the founder can relabel or close the issue, the
 * Telegram API can go down, and the VPS can reboot. None of these may crash the tick, lose the
 * outcome, or leave the loop unable to recover:
 *   - the founder removes agent:working mid-run  -> the run finishes and records its outcome;
 *   - the issue is closed mid-run                -> the PR still opens as a draft, and the
 *                                                   notification says the issue is closed;
 *   - Telegram is down                           -> dispatch state does not change (notify is || true);
 *   - the VPS reboots mid-run                    -> the stale lock and the stale claim are recovered
 *                                                   by the lease path that already existed.
 *
 * The fake agy can be told to do things "while it runs": its hook executes in the workspace
 * with the fake gh on PATH, which is exactly where the founder's hand would be.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, utimesSync } from "node:fs";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const BRANCH = "task/issue-710-test-docs-add-visible-test-comment";
/** Antigravity's work: a commit on the branch the daemon checked out, and a draft PR from it. */
const OPEN_A_PR =
  'git -c user.name=t -c user.email=t@t commit --allow-empty -q -m "work" && gh pr create --repo owner/founderos --head "$(git branch --show-current)" --title t --body b >/dev/null';
const REMOVE_WORKING = "gh issue edit 710 --repo owner/founderos --remove-label agent:working";
const CLOSE_ISSUE = "gh issue close 710 --repo owner/founderos";

let sb: DispatchSandbox;

beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
  sb.addIssue({ number: 710, title: "test(docs): add visible test comment" });
});

afterEach(() => {
  sb.destroy();
});

describe("the founder removes agent:working while Antigravity runs", () => {
  it("a failed run still records its outcome, the tick does not crash, and the log says the label was already gone", () => {
    const r = sb.tick({ agyOut: "Error: something else broke", agyHook: REMOVE_WORKING });

    expect(r.status).toBe(0);
    expect(sb.labelsOf(710)).toEqual(["agent:failed"]);
    expect(sb.log()).toMatch(/#710 no longer carries agent:working \(relabelled while Antigravity ran\)/);
    expect(sb.log()).toMatch(/tick complete/);
  });

  it("a run that opened a PR still hands the issue to review", () => {
    const r = sb.tick({ agyOut: "done", agyRc: 0, agyHook: `${OPEN_A_PR} && ${REMOVE_WORKING}` });

    expect(r.status).toBe(0);
    // engine:agy rides along with agent:review once a PR opens: the next pass reads it to know who wrote the PR
    expect(sb.labelsOf(710)).toEqual(["agent:review", "engine:agy"]);
    expect(sb.log()).toMatch(/no longer carries agent:working/);
    expect(sb.commentsOf(710).some((c) => c.startsWith("<!-- agent-pr:"))).toBe(true);
  });

  it("a transient run puts the issue back to the queue even though its claim label is gone", () => {
    sb.tick({ agyOut: "Error: timeout waiting for response", agyHook: REMOVE_WORKING });
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
  });
});

describe("the issue is closed while Antigravity runs", () => {
  it("the PR still opens as a draft and goes to review, and the notification says the issue is closed", () => {
    sb.tick({ agyOut: "done", agyRc: 0, agyHook: `${OPEN_A_PR} && ${CLOSE_ISSUE}` });

    expect(sb.prs()).toHaveLength(1);
    expect(sb.prs()[0]?.isDraft).toBe(true);
    expect(sb.prs()[0]?.headRefName).toBe(BRANCH);
    expect(sb.labelsOf(710)).toEqual(["agent:review", "engine:agy"]);
    expect(sb.ghLog()).not.toMatch(/pr close|pr merge/);

    const msg = sb.messages().find((m) => /PR #\d+ opened/.test(m)) ?? "";
    expect(msg).toContain("#710");
    expect(msg).toMatch(/CLOSED/);
    expect(sb.commentsOf(710).find((c) => c.startsWith("<!-- agent-pr:"))).toMatch(/CLOSED/);
  });

  it("an open issue gets the plain notification, with no mention of being closed", () => {
    sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR });

    const msg = sb.messages().find((m) => /PR #\d+ opened/.test(m)) ?? "";
    expect(msg).toContain("awaiting pr-brain review");
    expect(msg).not.toMatch(/CLOSED/);
  });
});

describe("Telegram is down", () => {
  it("a PR that opened is still handed to review: notify is best-effort and changes no dispatch state", () => {
    const r = sb.tick({ agyOut: "done", agyRc: 0, agyHook: OPEN_A_PR, curlRc: 7 });

    expect(r.status).toBe(0);
    expect(sb.labelsOf(710)).toEqual(["agent:review", "engine:agy"]);
    expect(sb.commentsOf(710).some((c) => c.startsWith("<!-- agent-pr:"))).toBe(true);
    expect(sb.log()).toMatch(/tick complete/);
  });

  it("a failed run is still marked and commented while Telegram is down", () => {
    const r = sb.tick({ agyOut: "Error: something else broke", curlRc: 7 });

    expect(r.status).toBe(0);
    expect(sb.labelsOf(710)).toEqual(["agent:failed"]);
  });
});

describe("the VPS rebooted mid-run: the existing lease path still recovers", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");

  it("reclaims a lock older than 90 minutes and carries on", () => {
    const lock = sb.statePath("agent-dispatch.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 120 * 60_000);
    utimesSync(lock, old, old);

    sb.tick({ agyOut: "Error: timeout waiting for response" });

    expect(sb.log()).toMatch(/stale lock older than 90m — reclaiming/);
    expect(sb.agyRuns()).toBe(1);
  });

  it("does NOT reclaim a fresh lock: another tick is genuinely running", () => {
    mkdirSync(sb.statePath("agent-dispatch.lock"));

    sb.tick({ agyOut: "Error: timeout waiting for response" });

    expect(sb.log()).toMatch(/another dispatch tick is running/);
    expect(sb.agyRuns()).toBe(0);
  });

  it("releases a claim older than the lease that has no PR, back to agent:ready", () => {
    sb.addIssue({
      number: 710,
      labels: ["agent:working"],
      comments: [`<!-- agent-claimed: ${minutesAgo(60)} --> 🤖 Claimed by agent-dispatch on vm. Branch: \`${BRANCH}\`.`],
    });

    sb.tick();

    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.commentsOf(710).some((c) => /released this claim after \d+ minutes/.test(c))).toBe(true);
    expect(sb.agyRuns()).toBe(0);
  });

  it("leaves a claim that is still inside the lease alone", () => {
    sb.addIssue({
      number: 710,
      labels: ["agent:working"],
      comments: [`<!-- agent-claimed: ${minutesAgo(10)} --> 🤖 Claimed by agent-dispatch on vm.`],
    });

    sb.tick();

    expect(sb.labelsOf(710)).toEqual(["agent:working"]);
  });

  it("leaves an old claim alone when its PR exists: that one belongs to review", () => {
    sb.ensureRemoteBranch("owner/founderos", BRANCH);
    sb.addIssue({
      number: 710,
      labels: ["agent:working"],
      comments: [`<!-- agent-claimed: ${minutesAgo(90)} --> 🤖 Claimed by agent-dispatch on vm.`],
    });
    sb.addPr({ number: 11, headRefName: BRANCH });

    sb.tick();

    expect(sb.labelsOf(710)).toEqual(["agent:working"]);
  });

  it("releases stale claims even while the loop is paused: that step never calls Antigravity", () => {
    sb.addIssue({
      number: 710,
      labels: ["agent:working"],
      comments: [`<!-- agent-claimed: ${minutesAgo(60)} --> 🤖 Claimed by agent-dispatch on vm.`],
    });
    sb.addIssue({ number: 711 });
    sb.tick({ agyOut: "Error: 403 PERMISSION_DENIED: The caller does not have permission" }); // pauses on #711, and releases #710

    expect(sb.hasState("agent-dispatch.down")).toBe(true);
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
  });
});
