/**
 * agent-dispatch must back off when Antigravity's quota is exhausted —
 * deploy/agent-dispatch.
 * ====================================================================
 * 2026-09-21 07:45–08:31 (VPS agent-dispatch.log): issue #710 was claimed and
 * run 5 times in 46 minutes. Every run died on the same line — "Individual
 * quota reached … Resets in 57h37m" — and every run marked the issue
 * agent:failed, as if the TASK had failed. Nothing in the script read the
 * reset time, so each tick (and each /task kick) walked into the same wall.
 *
 * These run the real script against the shared dispatch sandbox (a stateful `gh`
 * and stub sudo/agy/curl). The sandbox installs the daemon in the deployed layout
 * with the repo list narrowed to one repo (DISPATCH_REPOS_NODE): the daemon reads no other list.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const QUOTA_LINE =
  "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s.";

let sb: DispatchSandbox;

const quotaFile = () => sb.statePath("agent-dispatch.quota-until");

beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
  sb.addIssue({ number: 710, title: "test(docs): add visible test comment" });
});

afterEach(() => {
  sb.destroy();
});

describe("agent-dispatch — Antigravity quota exhausted", () => {
  it("puts the issue back to agent:ready (not agent:failed) and records when the quota resets", () => {
    sb.tick({ agyOut: QUOTA_LINE });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.ghLog()).toMatch(/issue edit 710 .*--remove-label agent:working --add-label agent:ready/);
    expect(sb.ghLog()).not.toMatch(/--add-label agent:failed/);
    const until = Number(readFileSync(quotaFile(), "utf8").trim());
    const expected = Date.now() / 1000 + (57 * 3600 + 37 * 60 + 44);
    expect(Math.abs(until - expected)).toBeLessThan(120);
  });

  it("does not run Antigravity again until the quota resets", () => {
    sb.tick({ agyOut: QUOTA_LINE });
    sb.tick({ agyOut: QUOTA_LINE });
    sb.tick({ agyOut: QUOTA_LINE });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.log()).toMatch(/quota exhausted until/i);
  });

  it("runs again once the recorded reset time has passed", () => {
    writeFileSync(quotaFile(), `${Math.floor(Date.now() / 1000) - 60}\n`);

    sb.tick({ agyOut: QUOTA_LINE });

    expect(sb.agyRuns()).toBe(1);
    expect(existsSync(quotaFile())).toBe(true); // re-written by this run's own quota hit
  });

  it("an ordinary failure still marks the issue agent:failed", () => {
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.ghLog()).toMatch(/--add-label agent:failed/);
    expect(existsSync(quotaFile())).toBe(false);
  });

  it("a quota wall with no 'Resets in' backs off one hour, not forever and not zero", () => {
    sb.tick({ agyOut: "error: Individual quota reached. Please upgrade your subscription." });

    const until = Number(readFileSync(quotaFile(), "utf8").trim());
    expect(Math.abs(until - (Date.now() / 1000 + 3600))).toBeLessThan(120);
    expect(sb.ghLog()).not.toMatch(/--add-label agent:failed/);
  });

  it("RESOURCE_EXHAUSTED counts as quota too, and does not read as a task failure", () => {
    sb.tick({ agyOut: "Error: 429 RESOURCE_EXHAUSTED: quota exceeded" });

    expect(existsSync(quotaFile())).toBe(true);
    expect(sb.labelsOf(710)).toContain("agent:ready");
    expect(sb.labelsOf(710)).not.toContain("agent:failed");
  });
});
