/**
 * deploy/job-run, stage "promote": the request {repo, stage: "promote", beta_sha} the /promote card sends.
 *
 * Same contract as a /task: the founder hears exactly ONE message. promote-run (stubbed here; its own tests are in
 * promote-run.test.ts) reports through a result file; job-run turns it into "✅ ..." on success and the one failure
 * message on anything else.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const JOB_RUN = fileURLToPath(new URL("../../../deploy/job-run", import.meta.url));
const REPO = "pushkarverma3698/FounderOS";
const SHA = "a".repeat(40);

let dir: string;

const sh = (name: string, body: string): void => {
  writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-run-promote-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "home", ".claude"), { recursive: true });
  writeFileSync(join(dir, "env"), "TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nTELEGRAM_CHAT_ID=42\nGITHUB_TOKEN=test-github-token\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(stdin: string, promote: { rc: number; result: string } = { rc: 0, result: "On prod: main 1234567." }) {
  const calls = join(dir, "calls");
  const sent = join(dir, "sent");
  writeFileSync(calls, "");
  writeFileSync(sent, "");
  writeFileSync(join(dir, "result.txt"), promote.result);
  sh("agent-dispatch", `echo "agent-dispatch $*" >>'${calls}'`);
  sh("pr-brain", `echo "pr-brain $*" >>'${calls}'`);
  sh("crontab", "true");
  sh("curl", `for a in "$@"; do printf '%s\\n' "$a"; done >>'${sent}'\nprintf '\\n--END--\\n' >>'${sent}'`);
  sh(
    "promote-run",
    `echo "promote-run $*" >>'${calls}'\n` +
      `echo "promote-run GH_TOKEN=$GH_TOKEN helpers=$GIT_CONFIG_COUNT" >>'${calls}'\n` +
      `while [ $# -gt 0 ]; do [ "$1" = --result-file ] && out="$2"; shift; done\n` +
      `cp '${join(dir, "result.txt")}' "$out"\nexit ${promote.rc}`,
  );
  const r = spawnSync("bash", [JOB_RUN], {
    input: stdin,
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: join(dir, "home"),
      TMPDIR: dir,
      JOB_RUN_ENV_FILE: join(dir, "env"),
      JOB_RUN_DISPATCH: join(dir, "bin", "agent-dispatch"),
      JOB_RUN_PR_BRAIN: join(dir, "bin", "pr-brain"),
      JOB_RUN_PROMOTE: join(dir, "bin", "promote-run"),
      JOB_RUN_CRONTAB: join(dir, "bin", "crontab"),
      JOB_RUN_KEEP_PATH: "1",
      JOB_RUN_READ_TIMEOUT: "5",
    },
    timeout: 30_000,
  });
  return {
    status: r.status ?? -1,
    sent: readFileSync(sent, "utf8").split("--END--\n").filter((m) => m.trim()),
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
  };
}

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

describe("deploy/job-run: stage promote", () => {
  it("runs promote-run with the repo and the approved commit, no issue, no dispatch, no review", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }));

    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toContain(`promote-run --repo ${REPO} --beta-sha ${SHA} --result-file`);
  });

  it("forwards base and deploy mode for an Oplify promotion, and defaults to main/box otherwise", () => {
    const oplify = run(line({ repo: "OplifyMessage/oplify-messaging-api", stage: "promote", beta_sha: SHA, base: "production", deploy: "workflow" }));
    expect(oplify.calls[0]).toContain("--base production --deploy workflow");
    const legacy = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }));
    expect(legacy.calls[0]).toContain("--base main --deploy box");
  });

  it("refuses a base that is not a plain branch name", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA, base: "main;touch x" }));
    expect(r.status).toBe(64);
    expect(r.calls).toHaveLength(0);
  });

  it("hands promote-run the bot's one GitHub token and the git credential helper that reads it", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }));

    expect(r.calls[1]).toBe("promote-run GH_TOKEN=test-github-token helpers=2");
  });

  it("a promotion with no GITHUB_TOKEN in the env file fails once, before promote-run starts", () => {
    writeFileSync(join(dir, "env"), "TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nTELEGRAM_CHAT_ID=42\n");
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }));

    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/GITHUB_TOKEN is not set/);
  });

  it("success is ONE message: the result, with a check mark", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }), { rc: 0, result: "On prod: main 1234567, deploy green." });

    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain("✅ On prod: main 1234567, deploy green.");
  });

  it("failure is ONE message that carries promote-run's own reason, labelled as a promotion", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }), { rc: 1, result: "Beta moved: you approved aaaaaaa, beta is now fffffff." });

    expect(r.status).not.toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain("Job failed: promote pushkarverma3698/FounderOS (beta aaaaaaa)");
    expect(r.sent[0]).toContain("Beta moved: you approved aaaaaaa, beta is now fffffff.");
  });

  it("a lock held by a running promotion (exit 75) is the same single message with its 'since'", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }), { rc: 75, result: "Already promoting since 09:41Z." });

    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain("exit 75");
    expect(r.sent[0]).toContain("Already promoting since 09:41Z.");
  });

  it("promote-run exiting 0 with an empty result is a failure, not silence", () => {
    const r = run(line({ repo: REPO, stage: "promote", beta_sha: SHA }), { rc: 0, result: "" });

    expect(r.status).not.toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/without a result/);
  });

  it.each([
    ["no beta_sha", { repo: REPO, stage: "promote" }],
    ["a short sha", { repo: REPO, stage: "promote", beta_sha: "abc1234" }],
    ["an uppercase or non-hex sha", { repo: REPO, stage: "promote", beta_sha: "Z".repeat(40) }],
    ["a bad repo", { repo: "o/r;rm -rf x", stage: "promote", beta_sha: SHA }],
  ])("rejects %s: runs nothing and says so once", (_name, req) => {
    const r = run(line(req));

    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/not a valid job request/);
  });

  it("a build or spec still needs an issue", () => {
    const r = run(line({ repo: REPO, stage: "build" }));

    expect(r.calls).toEqual([]);
    expect(r.sent[0]).toMatch(/not a valid job request/);
  });
});
