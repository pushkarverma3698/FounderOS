/**
 * What the daemons run with, reported for the bot's /review — deploy/vps-daemons/pr-brain, deploy/agent-dispatch.
 * ==============================================================================================================
 * On 2026-10-04 /review said "ON" and could not name a model. The bot read the crontab to learn the models, and
 * the bot runs under systemd's NoNewPrivileges=true, where `crontab -l` is denied. The daemons now write the
 * settings they are actually running with (defaults included) to ~/.claude/<daemon>.effective, and the bot reads
 * a file, which it is allowed to do.
 *
 * Pinned here, from the founder's side:
 *   - a normal sweep leaves the report, with the script's own defaults when the cron line sets nothing and the
 *     cron line's values when it does;
 *   - the report is written EVEN WHEN the kill switch is on, so /review off still shows the models;
 *   - a run that is not the cron's (--dry-run, --list, --repo, --pr, --issue, --check-brief, a
 *     --stage job) does not overwrite it: a manual run lacks the cron line's variables and would report the wrong models;
 *   - a report that cannot be written never stops a sweep.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const PR_BRAIN = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));
const AGENT_DISPATCH = fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url));

/** `key=value` lines of a report, as the bot parses them. */
function report(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) m.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return m;
}

const recent = (seconds: string | undefined): boolean => Math.abs(Date.now() / 1000 - Number(seconds)) < 120;

describe("agent-dispatch reports its writer models", () => {
  let sb: DispatchSandbox;
  beforeEach(() => {
    sb = new DispatchSandbox(["owner/founderos"]);
  });
  afterEach(() => sb.destroy());

  it("a normal tick writes the script's own defaults and a fresh timestamp", () => {
    sb.tick();
    expect(sb.hasState("agent-dispatch.effective")).toBe(true);
    const r = report(sb.readState("agent-dispatch.effective"));
    expect(r.get("agy_model")).toBe("gemini-3.6-flash-medium");
    expect(r.get("claude_model")).toBe("sonnet");
    expect(recent(r.get("written"))).toBe(true);
  });

  it("reports the values the cron line sets, not the defaults", () => {
    sb.tick({ env: { AGENT_DISPATCH_MODEL: "gemini-3.1-pro-high", AGENT_DISPATCH_CLAUDE_MODEL: "opus" } });
    const r = report(sb.readState("agent-dispatch.effective"));
    expect(r.get("agy_model")).toBe("gemini-3.1-pro-high");
    expect(r.get("claude_model")).toBe("opus");
  });

  it("is written even while the kill switch is on, so /review off still shows the models", () => {
    writeFileSync(sb.statePath("agent-dispatch.off"), "off\n");
    sb.tick();
    expect(sb.hasState("agent-dispatch.effective")).toBe(true);
  });

  it("is rewritten by every tick, not frozen at the first one", () => {
    sb.tick({ env: { AGENT_DISPATCH_MODEL: "first-model" } });
    sb.tick({ env: { AGENT_DISPATCH_MODEL: "second-model" } });
    expect(report(sb.readState("agent-dispatch.effective")).get("agy_model")).toBe("second-model");
  });

  it.each([["--dry-run"], ["--list"]])("%s does not touch the report", (flag) => {
    sb.tick({ args: [flag] });
    expect(sb.hasState("agent-dispatch.effective")).toBe(false);
  });

  it("a --stage job writes nothing", () => {
    sb.tick({ args: ["--issue", "1", "--repo", "o/r", "--stage", "spec"] });
    expect(sb.hasState("agent-dispatch.effective")).toBe(false);
  });

  it("a hand-run --issue does not overwrite the cron's report with the shell's environment", () => {
    sb.tick({ env: { AGENT_DISPATCH_MODEL: "cron-model" } });
    sb.tick({ args: ["--issue", "1"], env: { AGENT_DISPATCH_MODEL: "shell-model" } });
    expect(report(sb.readState("agent-dispatch.effective")).get("agy_model")).toBe("cron-model");
  });
});

describe("pr-brain reports its reviewers", () => {
  let root: string;
  let home: string;
  let bin: string;

  function stub(name: string, body: string): void {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  }

  /** One run of the real script against stub gh/claude/curl and an empty repository root. */
  function run(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
    const r = spawnSync("bash", [PR_BRAIN, ...args], {
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
        HOME: home,
        PR_BRAIN_ROOT: join(root, "empty"),
        PR_BRAIN_ENV_FILE: join(root, ".env"),
        PR_BRAIN_OWNER: "owner",
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const reportFile = (): string => join(home, ".claude", "pr-brain.effective");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pr-brain-effective-"));
    home = join(root, "home");
    bin = join(root, "bin");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(root, "empty"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");
    execFileSync("git", ["--version"], { stdio: "ignore" });
    stub("gh", `case "$*" in "api user"*) echo owner ;; "auth status"*) exit 0 ;; *) exit 0 ;; esac`);
    stub("claude", `[ -t 0 ] || cat >/dev/null\nprintf 'ok\\n'`);
    stub("curl", "exit 0");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a normal sweep writes the script's default reviewer list and merge setting", () => {
    run([]);
    const r = report(readFileSync(reportFile(), "utf8"));
    expect(r.get("engine")).toBe("agy");
    expect(r.get("reviewers")).toBe("claude-sonnet-5-5-medium gemini-3.1-pro-high");
    expect(r.get("merge")).toBe("1");
    expect(recent(r.get("written"))).toBe(true);
  });

  it("reports what the cron line sets: a comma list is shown space-separated, merge=0 is kept", () => {
    run([], { PR_BRAIN_MODELS: "model-a,model-b", PR_BRAIN_MERGE: "0" });
    const r = report(readFileSync(reportFile(), "utf8"));
    expect(r.get("reviewers")).toBe("model-a model-b");
    expect(r.get("merge")).toBe("0");
  });

  it("on the claude engine the reviewer is the one claude model", () => {
    run([], { PR_BRAIN_ENGINE: "claude", PR_BRAIN_MODEL: "opus" });
    const r = report(readFileSync(reportFile(), "utf8"));
    expect(r.get("engine")).toBe("claude");
    expect(r.get("reviewers")).toBe("opus");
  });

  it("is written even while the kill switch is on, so /review off still shows the models", () => {
    writeFileSync(join(home, ".claude", "pr-brain.off"), "off\n");
    const r = run([], { PR_BRAIN_MODELS: "model-a" });
    expect(r.out).toContain("kill switch present");
    expect(report(readFileSync(reportFile(), "utf8")).get("reviewers")).toBe("model-a");
  });

  it.each([[["--dry-run"]], [["--list"]], [["--repo", "x"]], [["--pr", "1"]]])("%j is not the cron's run and leaves the report alone", (args) => {
    run(args, { PR_BRAIN_MODELS: "shell-model" });
    expect(existsSync(reportFile())).toBe(false);
  });
});

/**
 * The writer itself, lifted out of each script and run on its own. The full-script runs above prove WHEN a report
 * is written; these prove HOW: one line per setting, replaced whole, and a failure that costs a log line and
 * nothing else. (A "directory where the file goes" cannot fake a failed write: `mv file dir` moves INTO the
 * directory and succeeds, so the failure is an uncreatable parent instead.)
 */
describe.each([
  ["pr-brain", PR_BRAIN],
  ["agent-dispatch", AGENT_DISPATCH],
])("%s write_effective", (_name, script) => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-effective-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the script's own function text. `log` is a stub that prints, as the daemons' log() does. */
  function call(file: string, ...settings: string[]): { rc: number | null; out: string } {
    const text = readFileSync(script, "utf8");
    const start = text.indexOf("\nwrite_effective() {");
    const end = text.indexOf("\n}\n", start);
    if (start < 0 || end < 0) throw new Error(`${script} no longer defines write_effective() { … }`);
    const fn = text.slice(start, end + 3);
    const r = spawnSync("bash", ["-c", `log() { echo "LOG: $*"; }\n${fn}\nwrite_effective "$@"`, "bash", file, ...settings], { encoding: "utf8" });
    return { rc: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("writes a timestamp and one line per setting, leaving no temp file behind", () => {
    const file = join(dir, "x.effective");
    const r = call(file, "a=1", "b=two words");
    expect(r.rc).toBe(0);
    const got = report(readFileSync(file, "utf8"));
    expect(got.get("a")).toBe("1");
    expect(got.get("b")).toBe("two words");
    expect(recent(got.get("written"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["x.effective"]);
  });

  it("replaces the previous report whole: a setting that is gone is gone", () => {
    const file = join(dir, "x.effective");
    call(file, "old=1");
    call(file, "new=2");
    const got = report(readFileSync(file, "utf8"));
    expect(got.has("old")).toBe(false);
    expect(got.get("new")).toBe("2");
  });

  it("flattens a newline in a value, so a setting cannot forge another key", () => {
    const file = join(dir, "x.effective");
    call(file, "reviewers=model-a\nmerge=1");
    const got = report(readFileSync(file, "utf8"));
    expect(got.get("reviewers")).toBe("model-a merge=1");
    expect(got.has("merge")).toBe(false);
  });

  it("an uncreatable report is a log line and a zero exit, never a failed sweep", () => {
    const r = call("/dev/null/nope/x.effective", "a=1");
    expect(r.rc).toBe(0);
    expect(r.out).toContain("LOG: could not write /dev/null/nope/x.effective");
  });
});
