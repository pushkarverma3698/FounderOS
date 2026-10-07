/**
 * deploy/job-run — the one process behind one /task.
 *
 * fos-job.socket starts it for each connection: it reads ONE JSON line {repo, issue, stage}, runs that one
 * issue through agent-dispatch (and pr-brain after a build) and guarantees the founder exactly one outcome
 * on Telegram: the card the run itself posted, or ONE failure message naming repo#N, the stage, the exit code
 * and the last 15 log lines. Silence is the failure this design removes, so most of the tests below are about
 * the ways a run could end without a card and must still end loudly, once.
 *
 * agent-dispatch, pr-brain, gh and curl are stand-ins on a hermetic PATH: nothing here touches the network.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const JOB_RUN = fileURLToPath(new URL("../../../deploy/job-run", import.meta.url));
const REPO = "pushkarverma3698/FounderOS";
const ENV_TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type Opts = {
  stdin?: string;
  dispatchRc?: number;
  dispatchLabels?: string[]; // labels the issue has AFTER agent-dispatch ran
  dispatchOut?: string;
  prs?: Array<{ number: number; headRefName: string; headRefOid?: string }>;
  prBrainRc?: number;
  marker?: boolean; // pr-brain's brain-reviewed marker is on the head
  crontab?: string;
  env?: Record<string, string>;
  readTimeout?: string;
};

let dir: string;

const sh = (name: string, body: string): void => {
  writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-run-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "home", ".claude"), { recursive: true });
  writeFileSync(join(dir, "env"), `TELEGRAM_BOT_TOKEN=${ENV_TOKEN}\nTELEGRAM_CHAT_ID=42\n`);
  writeFileSync(join(dir, "home", ".claude", "pr-brain.repos"), `# repos\n${join(dir, "checkouts", "FounderOS")}\n`);
  mkdirSync(join(dir, "checkouts", "FounderOS"), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(o: Opts = {}): { status: number; sent: string[]; calls: string[]; stderr: string } {
  const calls = join(dir, "calls");
  const sent = join(dir, "sent");
  writeFileSync(calls, "");
  writeFileSync(sent, "");
  writeFileSync(join(dir, "crontab.txt"), o.crontab ?? "");
  sh("crontab", `cat '${join(dir, "crontab.txt")}'`);
  sh(
    "agent-dispatch",
    `echo "agent-dispatch $* MODELS=\${AGENT_DISPATCH_MODELS:-}" >>'${calls}'\n` +
      `printf '%s\\n' '${o.dispatchOut ?? "line"}'\nexit ${o.dispatchRc ?? 0}`,
  );
  sh("pr-brain", `echo "pr-brain $*" >>'${calls}'\nexit ${o.prBrainRc ?? 0}`);
  const labels = JSON.stringify((o.dispatchLabels ?? []).map((name) => ({ name })));
  const prs = JSON.stringify(o.prs ?? []);
  const head = o.prs?.[0]?.headRefOid ?? "abcdef1234567890abcdef1234567890abcdef12";
  const comments = JSON.stringify(o.marker ? [{ body: `<!-- brain-reviewed: ${head.slice(0, 7)} -->` }] : []);
  sh(
    "gh",
    `echo "gh $*" >>'${calls}'\n` +
      `case "$*" in\n` +
      `  "issue view"*) echo '${labels}' | jq -r '.[].name' ;;\n` +
      `  "pr list"*) echo '${prs}' ;;\n` +
      `  "pr view"*) echo '{"headRefOid":"${head}","comments":${comments}}' ;;\n` +
      `esac`,
  );
  sh("curl", `for a in "$@"; do printf '%s\\n' "$a"; done >>'${sent}'\nprintf '\\n--END--\\n' >>'${sent}'`);

  const r = spawnSync("bash", [JOB_RUN], {
    input: o.stdin ?? JSON.stringify({ repo: REPO, issue: 41, stage: "build" }) + "\n",
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: join(dir, "home"),
      JOB_RUN_ENV_FILE: join(dir, "env"),
      JOB_RUN_DISPATCH: join(dir, "bin", "agent-dispatch"),
      JOB_RUN_PR_BRAIN: join(dir, "bin", "pr-brain"),
      JOB_RUN_CRONTAB: join(dir, "bin", "crontab"),
      JOB_RUN_KEEP_PATH: "1",
      JOB_RUN_READ_TIMEOUT: o.readTimeout ?? "5",
      ...o.env,
    },
    timeout: 30_000,
  });
  const out = readFileSync(sent, "utf8");
  return {
    status: r.status ?? -1,
    sent: out.split("--END--\n").filter((m) => m.trim()),
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
    stderr: r.stderr,
  };
}

const goodPr = { number: 77, headRefName: "task/issue-41-fix-thing" };

describe("deploy/job-run: the request line", () => {
  it("--help exits 0 without reading stdin (sync-daemons smoke-tests it)", () => {
    const r = spawnSync("bash", [JOB_RUN, "--help"], { encoding: "utf8", input: "", timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/job-run/);
  });

  it.each([
    ["not json", "hello\n"],
    ["a repo with a shell metacharacter", JSON.stringify({ repo: "o/r;rm -rf x", issue: 1, stage: "build" }) + "\n"],
    ["a repo with no owner", JSON.stringify({ repo: "justname", issue: 1, stage: "build" }) + "\n"],
    ["issue 0", JSON.stringify({ repo: REPO, issue: 0, stage: "build" }) + "\n"],
    ["a non-numeric issue", JSON.stringify({ repo: REPO, issue: "1;x", stage: "build" }) + "\n"],
    ["a stage that is neither spec nor build", JSON.stringify({ repo: REPO, issue: 1, stage: "deploy" }) + "\n"],
  ])("rejects %s: runs nothing and tells the founder once", (_name, stdin) => {
    const r = run({ stdin });

    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("agent-dispatch") || c.startsWith("pr-brain"))).toEqual([]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent.join("")).toMatch(/not a valid job request/);
  });

  it("an empty connection that never sends a line times out and says so once instead of hanging", () => {
    const t0 = Date.now();
    const r = run({ stdin: "", readTimeout: "1" });

    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.status).not.toBe(0);
    expect(r.sent).toHaveLength(1);
  });
});

describe("deploy/job-run: a build", () => {
  it("runs the forced issue at stage build, then pr-brain on the PR the dispatcher opened; the card is the outcome", () => {
    const r = run({ prs: [goodPr, { number: 90, headRefName: "task/issue-410-other" }], marker: true });

    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("agent-dispatch"))).toMatch(
      new RegExp(`--issue 41 --repo ${REPO} --stage build --wait-lock 3600`),
    );
    expect(r.calls.find((c) => c.startsWith("pr-brain"))).toBe(`pr-brain --repo ${join(dir, "checkouts", "FounderOS")} --pr 77`);
    expect(r.sent).toEqual([]); // pr-brain posted the card: job-run adds nothing
  });

  it("matches task/issue-N exactly, not task/issue-41x: a different issue's PR is not this job's", () => {
    const r = run({ prs: [{ number: 90, headRefName: "task/issue-410-other" }] });

    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("pr-brain"))).toEqual([]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/no pull request/i);
  });

  it("dispatch exit code is reported: repo#N, stage, code and the LAST 15 log lines, once", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `log-line-${i + 1}`).join("\\n");
    const r = run({ dispatchRc: 75, dispatchOut: lines });

    expect(r.status).toBe(75);
    expect(r.sent).toHaveLength(1);
    const msg = r.sent[0]!;
    expect(msg).toContain(`${REPO}#41`);
    expect(msg).toMatch(/stage build/);
    expect(msg).toMatch(/exit 75/);
    expect(msg).toContain("log-line-30");
    expect(msg).toContain("log-line-16");
    expect(msg).not.toContain("log-line-15\n");
    expect(msg).not.toContain("log-line-1\n");
  });

  it("agent-dispatch exiting 0 without opening a PR (its silent paths) is still a failure message", () => {
    const r = run({ dispatchRc: 0, prs: [] });

    expect(r.status).not.toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/no pull request/i);
  });

  it("pr-brain failing is a failure message with its exit code", () => {
    const r = run({ prs: [goodPr], prBrainRc: 3 });

    expect(r.status).toBe(3);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/pr-brain/);
    expect(r.sent[0]).toMatch(/exit 3/);
  });

  it("pr-brain exiting 0 with no review marker on the head (it skipped) is a failure message", () => {
    const r = run({ prs: [goodPr], marker: false });

    expect(r.status).not.toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/review|marker/i);
  });
});

describe("deploy/job-run: a spec", () => {
  it("runs stage spec and does not run pr-brain; agent:spec-review is the card", () => {
    const r = run({
      stdin: JSON.stringify({ repo: REPO, issue: 41, stage: "spec" }) + "\n",
      dispatchLabels: ["agent:spec-review"],
    });

    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("agent-dispatch"))).toMatch(/--stage spec/);
    expect(r.calls.filter((c) => c.startsWith("pr-brain"))).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("an issue still at agent:spec means nothing happened: one failure message", () => {
    const r = run({ stdin: JSON.stringify({ repo: REPO, issue: 41, stage: "spec" }) + "\n", dispatchLabels: ["agent:spec"] });

    expect(r.status).not.toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/stage spec/);
  });
});

describe("deploy/job-run: what the founder reads", () => {
  it("never leaks a secret from the log tail", () => {
    const r = run({ dispatchRc: 1, dispatchOut: `boom GOOGLE_GENERATIVE_AI_API_KEY=AIzaSyD-abcdefghijklmnopqrstuvwxyz0123` });

    expect(r.sent.join("")).not.toContain("AIzaSyD-abcdefghijklmnopqrstuvwxyz0123");
    expect(r.sent.join("")).toContain("[REDACTED]");
  });

  it("sends through the Telegram bot API with the chat id from the env file", () => {
    const r = run({ dispatchRc: 1 });

    const msg = r.sent[0]!;
    expect(msg).toContain(`https://api.telegram.org/bot${ENV_TOKEN}/sendMessage`);
    expect(msg).toContain("chat_id=42");
  });

  it("a failure message is sent even in quiet hours: the founder asked for this job", () => {
    const r = run({ dispatchRc: 1, env: { TG_QUIET_HOURS: "0-23" } });

    expect(r.sent).toHaveLength(1);
  });

  it("with no Telegram credentials it still exits non-zero (the journal has the log) and does not crash", () => {
    writeFileSync(join(dir, "env"), "SOMETHING=1\n");
    const r = run({ dispatchRc: 1 });

    expect(r.status).toBe(1);
    expect(r.sent).toEqual([]);
  });

  it("a SIGTERM mid-run still ends with the one message (the EXIT trap, not a silent death)", () => {
    sh("agent-dispatch", `sleep 30`);
    sh("curl", `printf 'sent\\n' >>'${join(dir, "sent2")}'`);
    sh("crontab", "true");
    const r = spawnSync(
      "bash",
      ["-c", `printf '%s\\n' '${JSON.stringify({ repo: REPO, issue: 41, stage: "build" })}' | bash '${JOB_RUN}' & p=$!; sleep 1.5; kill -TERM $p; wait $p; echo rc=$?`],
      {
        encoding: "utf8",
        env: {
          PATH: `${join(dir, "bin")}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
          HOME: join(dir, "home"),
          JOB_RUN_ENV_FILE: join(dir, "env"),
          JOB_RUN_DISPATCH: join(dir, "bin", "agent-dispatch"),
          JOB_RUN_PR_BRAIN: join(dir, "bin", "pr-brain"),
          JOB_RUN_CRONTAB: join(dir, "bin", "crontab"),
          JOB_RUN_KEEP_PATH: "1",
        },
        timeout: 30_000,
      },
    );
    expect(r.stdout).toMatch(/rc=143/);
    expect(readFileSync(join(dir, "sent2"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("deploy/job-run: the environment systemd does not give it", () => {
  it("takes the agent-dispatch crontab line's VAR=value words, so a job runs the models the sweep runs", () => {
    const r = run({
      crontab: `*/15 * * * * PATH=/usr/bin AGENT_DISPATCH_MODELS="m-one m-two" ${join(dir, "bin", "agent-dispatch")} >>/dev/null 2>&1\n`,
      prs: [goodPr],
      marker: true,
    });

    expect(r.calls.find((c) => c.startsWith("agent-dispatch"))).toContain("MODELS=m-one m-two");
  });

  it("ignores a crontab line that is not a plain VAR=value list (nothing from it is evaluated)", () => {
    const r = run({
      crontab: `*/15 * * * * A=$(touch ${join(dir, "pwned")}) ${join(dir, "bin", "agent-dispatch")}\n`,
      prs: [goodPr],
      marker: true,
    });

    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(r.status).toBe(0);
  });
});
