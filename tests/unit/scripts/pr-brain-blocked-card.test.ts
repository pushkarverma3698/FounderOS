/**
 * pr-brain + the blocked-PR card: deploy/lib/evidence-card.sh (bc_run) wired into deploy/vps-daemons/pr-brain.
 * ===========================================================================================================
 * Oplify PR #116, 2026-10-09: pr-brain blocked the PR with two blockers and the founder got "CHANGES REQUESTED — blocked",
 * a Merge line and a link. Now a blocked PR gets a card listing the blockers with Fix now / Close PR, and the bare line only
 * goes out when no card could be built or sent. These run the real script against stub `claude`, `gh`, `curl` and `node`
 * binaries; the stub `node` stands in for scripts/blocked-review-card.ts (its own tests: blocked-review-card-cli.test.ts)
 * and prints a canned line, so what is pinned here is the bash side: when the script is asked, and what reaches Telegram.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));

const BLOCKED = "CHANGES REQUESTED — blocked · feat: auth flows";
const CLEARED = "CLEARED — marked ready · feat: auth flows";
const CARD = JSON.stringify({
  status: "CARD",
  nonce: "n0nceBlocked01",
  parts: ["<b>PR #7 is blocked</b>\n1. The test expects 404", "<b>part two</b>"],
  reply_markup: {
    inline_keyboard: [[{ text: "Fix now", callback_data: "cp:fix:n0nceBlocked01" }, { text: "Close PR", callback_data: "cp:close_pr:n0nceBlocked01" }]],
  },
});

let root: string;
let home: string;
let bin: string;
let repo: string;

const f = (name: string): string => join(root, name);
const read = (name: string): string => (existsSync(f(name)) ? readFileSync(f(name), "utf8") : "");

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function sweep(opts: { out?: string; verdict?: string; curlFail?: boolean; quietNow?: string; flag?: string }): void {
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: home,
    PR_BRAIN_ROOT: join(root, "repos"),
    PR_BRAIN_ENV_FILE: f(".env"),
    PR_BRAIN_OWNER: "owner",
    PR_BRAIN_ENGINE: "claude",
    PR_BRAIN_PIPELINE_ROOT: root,
    PR_BRAIN_NODE: join(bin, "fakenode"),
    QA_APP_ROOT: join(root, "no-founderos"),
    FAKE_PRS: "7 aaaa1111 beta task/issue-7-x",
    FAKE_HEAD_REF: "task/issue-7-x",
    FAKE_VERDICT: opts.verdict ?? BLOCKED,
    FAKE_BC_OUT: opts.out ?? "",
    FAKE_CURL_FAIL: opts.curlFail ? "1" : "",
    GH_LOG: f("gh.log"),
    CURL_LOG: f("curl.log"),
    NODE_ARGS: f("node-args.log"),
    TG_QUIET_NOW: opts.quietNow ?? "12",
    ...(opts.flag === undefined ? {} : { AGENT_PIPELINE_V2: opts.flag }),
  };
  spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 30_000 });
}

const curlCalls = (): string[] => read("curl.log").split("\n@@\n").filter((s) => s.trim() !== "");
const cardSends = (): string[] => curlCalls().filter((c) => c.includes("is blocked") || c.includes("part two"));
const gateDone = (): string => curlCalls().find((c) => c.includes("Gate done")) ?? "";
const merged = (): boolean => /pr merge 7 --squash/.test(read("gh.log"));
const log = (): string => read("pr-brain.log") + read("home/.claude/pr-brain.log");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-bc-"));
  home = join(root, "home");
  bin = join(root, "bin");
  repo = join(root, "repos", "widgets");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(f(".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\nGITHUB_TOKEN=test-github-token\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/widgets.git"], { cwd: repo });

  stub("claude", `[ -t 0 ] || cat >/dev/null
case "$*" in *"reply with the single word ok"*) echo ok ;; *) echo done ;; esac`);
  stub(
    "gh",
    `echo "$*" >>"$GH_LOG"
case "$*" in
  "api user"*) echo owner ;;
  "auth status"*) exit 0 ;;
  "pr list"*) echo "$FAKE_PRS" ;;
  *"headRefName"*) echo "$FAKE_HEAD_REF" ;;
  *"headRefOid"*) echo aaaa1111 ;;
  *"--json comments"*) echo "" ;;
  *"reviewDecision"*) echo "$FAKE_VERDICT" ;;
  *"baseRefName"*) echo beta ;;
  *"--json url"*) echo "https://github.com/owner/widgets/pull/7" ;;
  *) exit 0 ;;
esac`,
  );
  stub(
    "curl",
    `{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '@@\\n'; } >>"$CURL_LOG"
[ -z "$FAKE_CURL_FAIL" ] || exit 22
echo '{"ok":true,"result":{"message_id":5}}'`,
  );
  stub("fakenode", `echo "$*" >>"$NODE_ARGS"\nprintf '%s\\n' "$FAKE_BC_OUT"`);
  stub("timeout", "exit 0");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pr-brain + blocked card", () => {
  it("a blocked PR gets the card (keyboard on the last part) and not the bare 'Gate done' line", () => {
    sweep({ out: CARD });
    const sends = cardSends();
    expect(sends).toHaveLength(2);
    expect(sends[0]).not.toContain("reply_markup=");
    expect(sends[0]).toContain("parse_mode=HTML");
    expect(sends[1]).toContain('"callback_data":"cp:fix:n0nceBlocked01"');
    expect(sends[1]).toContain('"callback_data":"cp:close_pr:n0nceBlocked01"');
    expect(gateDone()).toBe("");
    expect(merged()).toBe(false);
  });

  it("asks the script about this repo, PR and head, with the coding pipeline flag off", () => {
    sweep({ out: CARD });
    const args = read("node-args.log");
    expect(args).toContain("scripts/blocked-review-card.ts");
    expect(args).toContain("--repo owner/widgets");
    expect(args).toContain("--pr 7");
    expect(args).toContain("--head aaaa1111");
    expect(args).not.toContain("--verdict");
  });

  it("still sends the plain line, with the verdict, when the script finds nothing to show (NONE)", () => {
    sweep({ out: '{"status":"NONE","reason":"no verdict for aaaa111 on the PR"}' });
    expect(cardSends()).toHaveLength(0);
    expect(gateDone()).toContain("CHANGES REQUESTED");
    expect(log()).toContain("no blocked card: no verdict for aaaa111");
  });

  it("still sends the plain line when the script fails, and logs why", () => {
    sweep({ out: '{"status":"FAILED","error":"gh api repos/owner/widgets/pulls/7 failed (exit 1)"}' });
    expect(cardSends()).toHaveLength(0);
    expect(gateDone()).toContain("CHANGES REQUESTED");
    expect(log()).toContain("blocked card step failed: gh api repos/owner/widgets/pulls/7 failed");
  });

  it("still sends the plain line when the script prints nothing (a crash must not hide the verdict)", () => {
    sweep({ out: "" });
    expect(gateDone()).toContain("CHANGES REQUESTED");
  });

  it("logs, and does not claim a card was sent, when Telegram refuses it", () => {
    sweep({ out: CARD, curlFail: true });
    expect(log()).toContain("blocked card could not be sent to Telegram");
    expect(log()).not.toContain("blocked card sent");
  });

  it("sends the card without a sound in quiet hours (a decision is not dropped, only muted)", () => {
    sweep({ out: CARD, quietNow: "3" });
    const sends = cardSends();
    expect(sends).toHaveLength(2);
    for (const s of sends) expect(s).toContain("disable_notification=true");
  });

  it("a PR that was cleared is not asked about at all", () => {
    sweep({ out: CARD, verdict: CLEARED });
    expect(read("node-args.log")).toBe("");
    expect(cardSends()).toHaveLength(0);
    expect(gateDone()).toContain("CLEARED");
  });
});
