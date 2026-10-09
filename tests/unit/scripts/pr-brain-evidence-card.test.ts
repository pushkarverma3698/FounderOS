/**
 * pr-brain + the merge card — deploy/lib/evidence-card.sh wired into deploy/vps-daemons/pr-brain.
 * ================================================================================================
 * A reviewed job PR (branch task/issue-N) is merged only by the founder's [Merge] tap, never by pr-brain. These run the real script against stub `claude`, `gh`, `curl` and `node` binaries. The stub `node` stands in
 * for scripts/pipeline-evidence-card.ts (its own tests: pipeline-evidence-card-cli.test.ts) and prints a canned line, so
 * what is pinned here is only the bash side: which of legacy | none | carded | held happens, and what reaches Telegram.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));

const CARD = JSON.stringify({
  status: "CARD",
  nonce: "abc123",
  parts: ["<b>MERGE CARD</b>", "<b>part two</b>"],
  reply_markup: { inline_keyboard: [[{ text: "Merge", callback_data: "cp:merge:abc123" }]] },
  mergeable: true,
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

function sweep(opts: {
  ec?: string;
  flag?: string;
  headRef?: string;
  curlFail?: boolean;
  quietNow?: string;
  owner?: string;
  onePr?: boolean;
}): void {
  execFileSync("git", ["remote", "set-url", "origin", `https://github.com/${opts.owner ?? "owner"}/widgets.git`], { cwd: repo });
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: home,
    PR_BRAIN_ROOT: join(root, "repos"),
    PR_BRAIN_ENV_FILE: f(".env"),
    PR_BRAIN_OWNER: opts.owner ?? "owner",
    PR_BRAIN_ENGINE: "claude",
    PR_BRAIN_PIPELINE_ROOT: root,
    PR_BRAIN_NODE: join(bin, "fakenode"),
    QA_APP_ROOT: join(root, "no-founderos"),
    FAKE_PRS: `7 aaaa1111 beta ${opts.headRef ?? "task/issue-7-x"}`,
    FAKE_HEAD_REF: opts.headRef ?? "task/issue-7-x",
    FAKE_EC_OUT: opts.ec ?? "",
    FAKE_CURL_FAIL: opts.curlFail ? "1" : "",
    GH_LOG: f("gh.log"),
    CURL_LOG: f("curl.log"),
    EC_ARGS: f("ec-args.log"),
    TG_QUIET_NOW: opts.quietNow ?? "12",
    ...(opts.flag === undefined ? {} : { AGENT_PIPELINE_V2: opts.flag }),
  };
  spawnSync("bash", [SCRIPT, ...(opts.onePr ? ["--pr", "7"] : [])], { env, encoding: "utf8", timeout: 30_000 });
}

const merged = (): boolean => /pr merge 7 --squash/.test(read("gh.log"));
const curlCalls = (): string[] => read("curl.log").split("\n@@\n").filter((s) => s.trim() !== "");
const cardSends = (): string[] => curlCalls().filter((c) => c.includes("MERGE CARD") || c.includes("part two"));
const gateDone = (): string => curlCalls().find((c) => c.includes("Gate done")) ?? "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-ec-"));
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
  *"reviewDecision"*) echo "CLEARED — marked ready · title" ;;
  *"baseRefName"*) echo beta ;;
  *"--json url"*) echo "https://github.com/owner/widgets/pull/7" ;;
  *) exit 0 ;;
esac`,
  );
  // Every curl call is logged whole (text, reply_markup, disable_notification); Telegram answers ok unless told not to.
  stub(
    "curl",
    `{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '@@\\n'; } >>"$CURL_LOG"
[ -z "$FAKE_CURL_FAIL" ] || exit 22
echo '{"ok":true,"result":{"message_id":5}}'`,
  );
  stub("fakenode", `echo "$*" >>"$EC_ARGS"\nprintf '%s\\n' "$FAKE_EC_OUT"`);
  stub("timeout", "exit 0");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// AG-062: the card is keyed on the job (a task/issue-N PR), not on a spec contract, and needs no flag.
describe("pr-brain + merge card: every job PR it clears", () => {
  it("a job PR with no contract and no flag: the Merge card is sent and no merge is attempted", () => {
    sweep({ ec: CARD });
    expect(read("ec-args.log")).toContain("--issue 7");
    expect(cardSends()).toHaveLength(2);
    expect(merged()).toBe(false);
    expect(gateDone()).toContain("held for your Merge button");
  });
});

describe("pr-brain + merge card: paths that are not a card", () => {
  it("an AGENT_PIPELINE_V2 left in the env or the env file changes nothing: the flag is gone", () => {
    writeFileSync(f(".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\nGITHUB_TOKEN=test-github-token\nAGENT_PIPELINE_V2=0\n");
    sweep({ ec: CARD, flag: "0" });
    expect(read("ec-args.log")).toContain("--issue 7");
    expect(cardSends()).toHaveLength(2);
    expect(merged()).toBe(false);
  });

  it("the review did not clear (NONE): no card and no merge", () => {
    sweep({ ec: '{"status":"NONE","reason":"review is not APPROVE"}' });
    expect(read("ec-args.log")).toContain("--issue 7");
    expect(merged()).toBe(false);
    expect(cardSends()).toHaveLength(0);
    expect(gateDone()).toContain("not attempted (verdict was not CLEARED)");
  });

  it("a head that is not task/issue-N: the script is not asked, legacy path", () => {
    sweep({ ec: CARD, headRef: "feat/other" });
    expect(read("ec-args.log")).toBe("");
  });

  it("an OplifyMessage repo: a human merges there, the card path is not used", () => {
    sweep({ ec: CARD, owner: "OplifyMessage" });
    expect(read("ec-args.log")).toBe("");
    expect(merged()).toBe(false);
  });
});

describe("pr-brain + merge card: a job PR the review cleared", () => {
  it("sends the card with the keyboard on the LAST part, and does not merge", () => {
    sweep({ ec: CARD });
    expect(merged()).toBe(false);
    const sends = cardSends();
    expect(sends).toHaveLength(2);
    expect(sends[0]).not.toContain("reply_markup=");
    expect(sends[0]).toContain("parse_mode=HTML");
    expect(sends[1]).toContain('reply_markup={"inline_keyboard":[[{"text":"Merge","callback_data":"cp:merge:abc123"}]]}');
    expect(gateDone()).toContain("held for your Merge button");
  });

  it("asks the script about this repo, issue, PR, head and the verdict, and nothing else", () => {
    sweep({ ec: CARD });
    const args = read("ec-args.log");
    expect(args).toContain("scripts/pipeline-evidence-card.ts");
    expect(args).toContain("--repo owner/widgets");
    expect(args).toContain("--issue 7");
    expect(args).toContain("--pr 7");
    expect(args).toContain("--head aaaa1111");
    expect(args).toContain("--verdict CLEARED");
  });

  it("--pr mode (a hand run) reads the branch from GitHub, so the card path still runs", () => {
    sweep({ ec: CARD, onePr: true });
    expect(read("ec-args.log")).toContain("--issue 7");
    expect(cardSends()).toHaveLength(2);
    expect(merged()).toBe(false);
  });

  it("parses the issue from task/issue-N with no slug", () => {
    sweep({ ec: CARD, headRef: "task/issue-12" });
    expect(read("ec-args.log")).toContain("--issue 12");
  });

  it("holds the merge with the script's reason when the card could not be built (FAILED)", () => {
    sweep({ ec: '{"status":"FAILED","error":"the PR head moved since review"}' });
    expect(merged()).toBe(false);
    expect(cardSends()).toHaveLength(0);
    expect(gateDone()).toContain("HELD, not merged");
    expect(gateDone()).toContain("the PR head moved since review");
  });

  it("holds the merge when the arguments were refused (INVALID)", () => {
    sweep({ ec: '{"status":"INVALID","error":"--head must be a full sha"}' });
    expect(merged()).toBe(false);
    expect(gateDone()).toContain("--head must be a full sha");
  });

  it("holds the merge when the script prints nothing readable (a crash must not become a merge)", () => {
    sweep({ ec: "" });
    expect(merged()).toBe(false);
    expect(gateDone()).toContain("HELD, not merged");
  });

  it("holds the merge when the script prints something unknown", () => {
    sweep({ ec: '{"status":"PASS"}' });
    expect(merged()).toBe(false);
  });

  it("holds the merge, and says so, when Telegram refuses the card", () => {
    sweep({ ec: CARD, curlFail: true });
    expect(merged()).toBe(false);
    expect(read("pr-brain.log") + read("home/.claude/pr-brain.log")).toContain("merge held");
  });

  it("sends the card without a sound in quiet hours (a decision is not dropped, only muted)", () => {
    sweep({ ec: CARD, quietNow: "3" });
    const sends = cardSends();
    expect(sends).toHaveLength(2);
    for (const s of sends) expect(s).toContain("disable_notification=true");
    expect(merged()).toBe(false);
  });

  it("sends with a sound in the day", () => {
    sweep({ ec: CARD, quietNow: "12" });
    for (const s of cardSends()) expect(s).not.toContain("disable_notification");
  });
});

describe("pr-brain + merge card: no other route to a merge", () => {
  it("merge_cleared is called from merge_or_card only, so the carry-forward path cannot skip the card", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const calls = src.split("\n").filter((l) => /^\s*(\*\) )?merge_cleared "\$pr"/.test(l.trim()) || /\bmerge_cleared "\$pr"/.test(l));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('*) merge_cleared "$pr" "$verdict" ;;');
    expect(src.match(/merge_or_card "\$pr"/g)).toHaveLength(2);
  });
});
