/**
 * AG-039 — one GitHub token, one repo list.
 * =========================================
 * Before: every daemon rode on the Linux user's own `gh auth login` (a second token, one per user, nobody could see
 * which), and the repo list lived twice (DEFAULT_REPOS in deploy/agent-dispatch, DISPATCH_REPO_ALLOWLIST in
 * src/tools/dispatch-repos.ts) with a CI test holding them equal. A repo reachable by the bot's token but not by the
 * daemon's user was a /task that filed an issue nothing would ever claim.
 *
 * Now: the bot's GITHUB_TOKEN is read from the env file the daemon already sources, exported as GH_TOKEN for every
 * gh and git call, and handed to the antigravity shell on STDIN (never argv, never a URL). The repo list is the
 * allowlist itself, printed by scripts/print-dispatch-repos.ts. These tests pin all of that against the real scripts.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISPATCH_REPO_ALLOWLIST } from "../../../src/tools/dispatch-repos.js";
import { DispatchSandbox, FAKE_GITHUB_TOKEN } from "./dispatch-sandbox.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NO_CHANGE = "Error: timeout waiting for response"; // a transient agy failure: the run happens, nothing else

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

let sb: DispatchSandbox;
beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
  sb.addIssue({ number: 710, title: "test(docs): add visible test comment" });
});
afterEach(() => sb.destroy());

describe("one repo list: the allowlist, printed", () => {
  it("scripts/print-dispatch-repos.ts prints DISPATCH_REPO_ALLOWLIST, one slug per line and nothing else", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/print-dispatch-repos.ts"], { cwd: ROOT, encoding: "utf8" });

    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([...DISPATCH_REPO_ALLOWLIST]);
  });

  it("DEFAULT_REPOS no longer exists in deploy/, src/ or scripts/", () => {
    const hits = ["deploy", "src", "scripts"]
      .flatMap((d) => filesUnder(join(ROOT, d)))
      .filter((f) => /\.(sh|ts)$|\/(agent-dispatch|pr-brain|job-run)$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("DEFAULT_REPOS"));
    expect(hits).toEqual([]);
  });

  it("agent-dispatch --list sweeps exactly the repos the printer prints (the real file, the real printer)", () => {
    const r = sb.runInPlace(["--list"], { DISPATCH_REPOS_ROOT: ROOT });

    const listed = [...r.stdout.matchAll(/agent:ready issues in (\S+):/g)].map((m) => m[1]);
    expect(listed).toEqual([...DISPATCH_REPO_ALLOWLIST]);
  });
});

describe("one token: GITHUB_TOKEN from the env file, as GH_TOKEN, on stdin to the antigravity shell", () => {
  it("every gh call, and the agy run itself, carries the bot's token", () => {
    sb.tick({ agyOut: NO_CHANGE });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.ghTokensSeen().length).toBeGreaterThan(3);
    expect(new Set(sb.ghTokensSeen())).toEqual(new Set([FAKE_GITHUB_TOKEN]));
    expect(sb.agyGhTokensSeen()).toEqual([FAKE_GITHUB_TOKEN]);
  });

  it("git push/fetch inside the antigravity shell go through a credential helper that reads the env var", () => {
    sb.tick({ agyOut: NO_CHANGE });

    const config = sb.agyGitConfigSeen().join("\n");
    expect(config).toContain("password=$GH_TOKEN"); // the helper names the variable, never the value
    expect(config).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it("the token is in no argv, URL, log, Telegram message, GitHub call or state file", () => {
    sb.tick({ agyOut: `debug: remote said ${FAKE_GITHUB_TOKEN}\n${NO_CHANGE}` });

    expect(sb.sudoCalls().join("\n")).not.toContain(FAKE_GITHUB_TOKEN);
    expect(sb.sudoCalls().join("\n")).not.toMatch(/GH_TOKEN=|GITHUB_TOKEN=/);
    expect(sb.ghLog()).not.toContain(FAKE_GITHUB_TOKEN);
    expect(sb.log()).not.toContain(FAKE_GITHUB_TOKEN);
    expect(sb.telegram().map((c) => c.text).join("\n")).not.toContain(FAKE_GITHUB_TOKEN);
    expect(sb.allStateText()).not.toContain(FAKE_GITHUB_TOKEN);
    expect(sb.log()).toContain("[REDACTED]");
  });

  it("no script in deploy/ puts a token on a sudo command line or inside a git URL", () => {
    const scripts = filesUnder(join(ROOT, "deploy")).filter((f) => /\.sh$|\/(agent-dispatch|pr-brain|job-run)$/.test(f));
    expect(scripts.length).toBeGreaterThan(8);
    for (const f of scripts) {
      const text = readFileSync(f, "utf8");
      expect(text, `${f}: sudo ... GH_TOKEN=`).not.toMatch(/sudo[^\n]*(GH_TOKEN|GITHUB_TOKEN)=/);
      expect(text, `${f}: a token inside a URL`).not.toMatch(/https:\/\/[^\s"']*(\$\{?GH_TOKEN|\$\{?GITHUB_TOKEN|x-access-token:\$)/);
    }
  });

  it("an env file without GITHUB_TOKEN pauses the loop ONCE, naming the file and the variable, and runs nothing", () => {
    sb.writeEnvFile("TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_CHAT_ID=1\n");
    for (let i = 0; i < 3; i++) expect(sb.tick({ agyOut: NO_CHANGE }).status).toBe(0);

    expect(sb.agyRuns()).toBe(0);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toContain("PAUSED");
    expect(sb.messages()[0]).toContain("GITHUB_TOKEN");
    expect(sb.messages()[0]).toContain(sb.envFile);
    expect(sb.messages()[0]).not.toMatch(/gh auth login/);
  });

  it("a token GitHub rejects pauses with the same fix, not 'gh auth login' for a user", () => {
    sb.patchGh({ authOk: false });
    sb.tick({ agyOut: NO_CHANGE });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.messages()[0]).toContain("GITHUB_TOKEN");
    expect(sb.messages()[0]).not.toMatch(/gh auth login/);
  });
});
