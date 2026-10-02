/**
 * pr-brain with Antigravity as the reviewer — deploy/vps-daemons/pr-brain, PR_BRAIN_ENGINE=agy (the default).
 * ===========================================================================================================
 * Claude's weekly limit paused every review from 2026-10-01 to 10-05 and the review half of the Telegram
 * loop stopped with it. The founder wanted agy as both executor and reviewer. An attempt (PR #791) swapped
 * the CLI in place and got most of it wrong:
 *   - it ran `agy "--print …"` as one argument, so agy opened its TUI ("could not open TTY") and six
 *     "PAUSED" messages followed in thirteen minutes;
 *   - it passed no model different from the executor's, the opposite of "the executor is never its own grader";
 *   - the model was trusted to run `gh pr ready` and to stamp the reviewed marker; a run that forgot either
 *     left a PR neither cleared nor re-gated;
 *   - it reviewed in a directory the antigravity user cannot write to, so nothing could be built or tested.
 *
 * What is pinned here is what the founder would feel, run against the real script with stub gh, sudo, agy and
 * curl. The model PROPOSES a verdict (`BRAIN-VERDICT: PASS|FAIL`, its last line); the script ACTS on it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));
const SLUG = "OplifyMessage/oplify-messaging-api";

let root: string;
let home: string;
let bin: string;
let ghDir: string;
let head: string;

const result = (response: string, status = "SUCCESS", error = ""): string =>
  JSON.stringify({ event: "result", result: { conversation_id: "c", status, response, ...(error ? { error } : {}), duration_seconds: 9, num_turns: 3 } });
const toolStep = (index: number, state: "ACTIVE" | "DONE", name: string, parameters: Record<string, unknown>): string =>
  JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: index, state, step_type: "tool", tool_name: name, tool_info: { name, parameters } } });
/** What agy prints for a review that ended with this final message. */
const review = (finalMessage: string): string =>
  [toolStep(2, "DONE", "run_command", { CommandLine: "npm test" }), toolStep(3, "DONE", "run_command", { CommandLine: `gh pr comment 56 --repo ${SLUG}` }), result(finalMessage)].join("\n") + "\n";

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

interface SweepOptions {
  readonly agyOut?: string;
  readonly agyErr?: string;
  readonly agyRc?: number;
  readonly preflight?: string;
  readonly preflightRc?: number;
  /** Bash run INSIDE the fake agy review, in the review workspace: the founder's hand, or the model's. */
  readonly agyHook?: string;
  readonly env?: Record<string, string>;
  readonly args?: readonly string[];
  /** Open PRs as `gh pr list` prints them. Default: PR 56 at the checked-out head. */
  readonly prs?: string;
}

function sweep(opts: SweepOptions = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...(opts.args ?? [])], {
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
      HOME: home,
      PR_BRAIN_ROOT: join(root, "repos"),
      PR_BRAIN_ENV_FILE: join(root, ".env"),
      PR_BRAIN_OWNER: "owner",
      PR_BRAIN_REVIEW_WORKSPACES: join(root, "review-ws"),
      PR_BRAIN_GITHUB_URL: join(root, "github"),
      PR_BRAIN_SKILL_FILE: join(root, "SKILL.md"),
      PR_BRAIN_PROGRESS_POLL_SEC: "0",
      QA_APP_ROOT: join(root, "no-founderos"),
      GH_DIR: ghDir,
      FAKE_HEAD: head,
      PR_LIST: opts.prs ?? `56 ${head}`,
      FAKE_PREFLIGHT: opts.preflight ?? "ok",
      FAKE_PREFLIGHT_RC: String(opts.preflightRc ?? 0),
      AGY_OUT: opts.agyOut ?? "",
      AGY_ERR: opts.agyErr ?? "",
      AGY_RC: String(opts.agyRc ?? 0),
      AGY_HOOK: opts.agyHook ?? "",
      AGY_LOGS: join(root, "agy"),
      CLAUDE_CALLS: join(root, "claude-calls.log"),
      SENDS: join(root, "sends.log"),
      ...opts.env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Tg {
  readonly kind: string;
  readonly text: string;
}
function telegram(): Tg[] {
  const f = join(root, "sends.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n@@\n")
    .filter((s) => s.trim() !== "")
    .map((rec) => {
      const tab = rec.indexOf("\t");
      return { kind: rec.slice(0, tab), text: rec.slice(tab + 1) };
    });
}
/** What reached the founder as a NEW message (an edit of the progress message is silent). */
const sent = (): string[] => telegram().filter((c) => c.kind === "send").map((c) => c.text);
const edits = (): string[] => telegram().filter((c) => c.kind === "edit").map((c) => c.text);
const ghCalls = (): string[] => (existsSync(join(ghDir, "calls.log")) ? readFileSync(join(ghDir, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
const ghState = (name: string): string => (existsSync(join(ghDir, name)) ? readFileSync(join(ghDir, name), "utf8").trim() : "");
const agyLog = (name: string): string[] => {
  const f = join(root, "agy", name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const prBrainLog = (): string => readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");
const claudeCalls = (): number => (existsSync(join(root, "claude-calls.log")) ? readFileSync(join(root, "claude-calls.log"), "utf8").split("\n").filter(Boolean).length : 0);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-agy-"));
  home = join(root, "home");
  bin = join(root, "bin");
  ghDir = join(root, "gh");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(root, "agy"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");
  writeFileSync(join(ghDir, "draft"), "true\n");
  writeFileSync(join(root, "SKILL.md"), "---\nname: pr-adversary\ndescription: x\n---\n\n# Adversarial PR Gate\n\nTry to DISPROVE that it is done.\n");

  // The repository pr-brain sweeps, and the "GitHub" its review workspace is cloned from: a bare origin whose
  // refs/pull/56/head is the PR head, at <PR_BRAIN_GITHUB_URL>/<slug>.git.
  const bare = join(root, "github", `${SLUG}.git`);
  mkdirSync(join(root, "github", "OplifyMessage"), { recursive: true });
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "x\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", bare, "main");
  git(seed, "checkout", "-q", "-b", "task/issue-72-x");
  writeFileSync(join(seed, "feature.txt"), "work\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "work");
  head = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", bare, "task/issue-72-x");
  git(bare, "update-ref", "refs/pull/56/head", head);

  const repo = join(root, "repos", "oplify-messaging-api");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${SLUG}.git`], { cwd: repo });

  // A stateful gh: `draft` and `comments` are the PR, every call is logged. An employer-org repo, so a cleared PR
  // is marked ready and the merge is withheld: the merge path has its own tests.
  stub(
    "gh",
    `echo "$*" >>"$GH_DIR/calls.log"
case "$*" in
  "api user"*) echo owner ;;
  "auth status"*) exit 0 ;;
  "pr list"*) [ -n "$PR_LIST" ] && echo "$PR_LIST" ;;
  "pr checkout "*) exit 0 ;;
  "pr ready "*"--undo"*) echo true >"$GH_DIR/draft" ;;
  "pr ready "*) echo false >"$GH_DIR/draft" ;;
  "pr comment "*) body=""; while [ $# -gt 0 ]; do [ "$1" = "--body" ] && body="$2"; shift; done; printf '%s\\n' "$body" >>"$GH_DIR/comments" ;;
  *"app-evidence"*) : ;;
  *"--json comments"*) cat "$GH_DIR/comments" 2>/dev/null; if [ -n "\${GH_SLOW_TAIL:-}" ]; then sleep 0.3; echo "-- a later comment --"; fi ;;
  *"headRefOid"*) echo "$FAKE_HEAD" ;;
  *"--json isDraft --jq .isDraft"*) cat "$GH_DIR/draft" ;;
  *"reviewDecision"*) if [ "$(cat "$GH_DIR/draft")" = true ]; then echo "REVIEWED, left as draft — not cleared · feat: x"; else echo "CLEARED — marked ready for merge (self-approval impossible; ready IS the pass) · feat: x"; fi ;;
  *"baseRefName"*) echo beta ;;
  *"--json url"*) echo "https://github.com/${SLUG}/pull/56" ;;
  *) exit 0 ;;
esac`,
  );
  // sudo -u antigravity -- bash -lc SCRIPT _ args  ->  run it as ourselves, keeping stdin and the environment.
  stub("sudo", `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
  stub("timeout", `shift; exec "$@"`);
  // The preflight is the one agy call whose prompt asks for "ok", in text mode. A review records where it ran.
  // AGY_PREFLIGHT_QUOTA_MODELS / AGY_REVIEW_QUOTA_MODELS: models whose quota is gone, for the preflight / for a review.
  stub(
    "agy",
    `model=""; prev=""
for a in "$@"; do [ "$prev" = "--model" ] && model="$a"; prev="$a"; done
# What agy printed on 2026-10-02 when a model's quota ran out: its own line on stderr and, in stream mode, a result
# event whose answer is the whole narration so far. That length (about 100 lines) pushed the error out of the failure
# classifier's window, and the run was counted as an ordinary failed attempt.
quota_wall() {
  q='Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 69h26m28s.'
  printf 'error: %s (response may be truncated)\\n' "$q" >&2
  case "$*" in *stream-json*)
    narr=""; i=0; while [ "$i" -lt 100 ]; do narr="\${narr}Checking file $i.\\\\n"; i=$((i + 1)); done
    printf '{"event":"result","result":{"status":"ERROR","error":"%s","response":"%s"}}\\n' "$q" "$narr" ;;
  esac
  exit 3
}
case "$*" in *"reply with the single word ok"*)
  echo "$model" >>"$AGY_LOGS/pf-models"
  case " \${AGY_PREFLIGHT_QUOTA_MODELS:-} " in *" $model "*) quota_wall "$@" ;; esac
  printf '%s\\n' "$FAKE_PREFLIGHT"; exit "$FAKE_PREFLIGHT_RC" ;; esac
echo review >>"$AGY_LOGS/calls"
echo "$model" >>"$AGY_LOGS/model"
case " \${AGY_REVIEW_QUOTA_MODELS:-} " in *" $model "*) quota_wall "$@" ;; esac
pwd >>"$AGY_LOGS/cwd"; git rev-parse HEAD >>"$AGY_LOGS/head" 2>&1; git remote get-url --push origin >>"$AGY_LOGS/push" 2>&1
while [ $# -gt 0 ]; do case "$1" in --print) printf '%s\\n----\\n' "$2" >>"$AGY_LOGS/prompts"; shift 2 ;; *) shift ;; esac; done
[ -n "\${AGY_HOOK:-}" ] && bash -c "$AGY_HOOK"
printf '%s' "$AGY_OUT"; printf '%s' "$AGY_ERR" >&2
exit "$AGY_RC"`,
  );
  stub("claude", `echo call >>"$CLAUDE_CALLS"; exit 1`);
  stub(
    "curl",
    `kind=""; text=""
for a in "$@"; do case "$a" in
  */sendMessage) kind=send ;;
  */editMessageText) kind=edit ;;
  */deleteMessage) kind=delete ;;
  text=*) text="\${a#text=}" ;;
esac; done
printf '%s\\t%s\\n@@\\n' "$kind" "$text" >>"$SENDS"
printf '{"ok":true,"result":{"message_id":7}}\\n'`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a PASS verdict", () => {
  it("clears the PR: the script makes it ready, stamps the head, and tells the founder — and never touches Claude", () => {
    const r = sweep({ agyOut: review("All checks pass.\n\nBRAIN-VERDICT: PASS") });

    expect(r.status).toBe(0);
    expect(ghState("draft")).toBe("false");
    expect(ghCalls()).toContain("pr ready 56");
    expect(ghState("comments")).toContain(`<!-- brain-reviewed: ${head} -->`);
    expect(sent().find((m) => m.startsWith("🧠 Gate done"))).toMatch(/CLEARED/);
    expect(claudeCalls()).toBe(0);
    expect(prBrainLog()).toMatch(/gating oplify-messaging-api#56 .*engine=agy model=claude-sonnet-4-6/);
  });

  it("does not post a second marker when the model stamped the head itself", () => {
    sweep({ agyOut: review("ok\nBRAIN-VERDICT: PASS"), agyHook: `gh pr comment 56 --body "<!-- brain-reviewed: ${head} -->"` });

    expect(ghState("comments").split("\n").filter((l) => l.includes(`brain-reviewed: ${head}`))).toHaveLength(1);
  });

  it("reads the LAST verdict line when the review quotes the protocol's own tokens earlier", () => {
    sweep({ agyOut: review("The protocol says BRAIN-VERDICT: PASS or FAIL.\nBRAIN-VERDICT: FAIL\nafter more thought\nBRAIN-VERDICT: PASS") });

    expect(ghState("draft")).toBe("false");
  });
});

describe("a FAIL verdict", () => {
  it("leaves the PR a draft, stamps the head (so agent-dispatch sees a reviewed-and-uncleared PR), and says 'not cleared'", () => {
    sweep({ agyOut: review("Blocker: the test asserts nothing.\nBRAIN-VERDICT: FAIL") });

    expect(ghState("draft")).toBe("true");
    expect(ghCalls()).not.toContain("pr ready 56");
    expect(ghState("comments")).toContain(`<!-- brain-reviewed: ${head} -->`);
    expect(sent().find((m) => m.startsWith("🧠 Gate done"))).toMatch(/left as draft — not cleared/);
  });

  it("puts a PR back to draft when the model made it ready against its own FAIL verdict", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: FAIL"), agyHook: "gh pr ready 56" });

    expect(ghState("draft")).toBe("true");
    expect(ghCalls()).toContain("pr ready 56 --undo");
  });
});

describe("a review that did not reach a verdict is not a pass and not a fail", () => {
  it("is a failed attempt: nothing is changed or stamped, and the founder hears once, then again only when it gives up", () => {
    const out = review("I ran out of time before finishing the audit");

    sweep({ agyOut: out });
    expect(ghState("draft")).toBe("true");
    expect(ghState("comments")).not.toContain("brain-reviewed");
    expect(sent().filter((m) => m.startsWith("⚠️ Gate FAILED to complete"))).toHaveLength(1);

    sweep({ agyOut: out });
    sweep({ agyOut: out });
    expect(sent().filter((m) => m.startsWith("⚠️ Gate FAILED to complete"))).toHaveLength(1);
    expect(sent().filter((m) => m.startsWith("🛑 Gate gave up"))).toHaveLength(1);

    sweep({ agyOut: out }); // a fourth tick leaves the head alone
    expect(agyLog("calls")).toHaveLength(3);
    expect(prBrainLog()).toMatch(/gate failed 3 times at/);
  });

  it("a --print-timeout (exit 0, partial output) is exactly that case", () => {
    sweep({ agyOut: toolStep(2, "ACTIVE", "run_command", { CommandLine: "pnpm test" }) + "\n", agyErr: "[agy] print timeout after 1680s with turn in progress; returning partial output\n" });

    expect(ghState("comments")).not.toContain("brain-reviewed");
    expect(sent().filter((m) => m.startsWith("⚠️ Gate FAILED to complete"))).toHaveLength(1);
  });

  it("a non-zero exit is a failed attempt even if a verdict line was printed", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), agyRc: 1 });

    expect(ghState("draft")).toBe("true");
    expect(ghState("comments")).not.toContain("brain-reviewed");
  });
});

describe("where and how the reviewer runs", () => {
  it("in its OWN clone of the repo, on the PR head, with pushing disabled", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    expect(agyLog("cwd")).toEqual([join(root, "review-ws", "oplify-messaging-api")]);
    expect(agyLog("head")).toEqual([head]);
    expect(agyLog("push")).toEqual(["https://push-disabled.invalid/"]);
  });

  it("with a model that is NOT the executor's, as `agy --model` (the executor runs gemini-3.6-flash-medium)", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    expect(agyLog("model")).toEqual(["claude-sonnet-4-6"]);
    expect(agyLog("model")[0]).not.toMatch(/gemini/);
  });

  it("honours PR_BRAIN_MODEL", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { PR_BRAIN_MODEL: "gemini-3.1-pro-high" } });

    expect(agyLog("model")).toEqual(["gemini-3.1-pro-high"]);
  });

  it("is told the whole protocol (inlined: the antigravity user has no pr-adversary skill) and the rules that override it", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    const prompt = agyLog("prompts").join("\n");
    expect(prompt).toContain("# Adversarial PR Gate");
    expect(prompt).toContain("Try to DISPROVE that it is done.");
    expect(prompt).not.toContain("name: pr-adversary"); // the front matter is not part of the protocol
    expect(prompt).toContain("Verdict B (fix and push) is DISABLED");
    expect(prompt).toContain(`--repo ${SLUG}`);
    expect(prompt).toContain("BRAIN-VERDICT: PASS");
    expect(prompt).toContain("BRAIN-VERDICT: FAIL");
    expect(prompt).not.toMatch(/Invoke the pr-adversary skill/);
  });

  it("still gives a usable prompt when the protocol file is missing (and does not pretend it was read)", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { PR_BRAIN_SKILL_FILE: join(root, "nope.md") } });

    expect(agyLog("prompts").join("\n")).toContain("is not readable on this machine");
  });

  it("checks the PR head out for the browser gate BEFORE the gate runs (it used to render the previous review's branch)", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    const calls = ghCalls();
    const checkout = calls.findIndex((c) => c === "pr checkout 56 --force");
    const evidence = calls.findIndex((c) => c.startsWith("pr comment 56 --body <!-- app-evidence -->"));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(evidence).toBeGreaterThan(checkout);
  });

  it("when the workspace cannot be prepared the gate fails loudly in the log instead of reviewing the wrong tree", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { PR_BRAIN_GITHUB_URL: join(root, "nowhere") } });

    expect(agyLog("calls")).toHaveLength(0);
    expect(prBrainLog()).toMatch(/could not prepare the review workspace/);
    expect(ghState("draft")).toBe("true");
  });
});

describe("what the founder watches in Telegram", () => {
  it("ONE progress message, edited while the review runs and ended with the verdict; never deleted", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), agyHook: "sleep 1" });

    const progress = sent().filter((m) => m.startsWith("🔧 Reviewing oplify-messaging-api#56"));
    expect(progress).toHaveLength(1);
    expect(telegram().filter((c) => c.kind === "delete")).toHaveLength(0);
    const last = edits().at(-1) ?? "";
    expect(last).toMatch(/^✅ Reviewing oplify-messaging-api#56\n⏱ .* · claude-sonnet-4-6 · 2 tool calls/);
    expect(last).toContain("✅ run npm test");
    expect(last).toContain("BRAIN-VERDICT: PASS");
  });
});

describe("when the reviewer cannot run (an outage, announced once)", () => {
  it("a rejected login pauses the sweep with ONE message that names the fix, and runs no gate", () => {
    sweep({ preflight: "Error: authentication timed out.\nerror: authentication failed or timed out", preflightRc: 1 });
    sweep({ preflight: "Error: authentication timed out.", preflightRc: 1 });
    sweep({ preflight: "Error: authentication timed out.", preflightRc: 1 });

    const paused = sent().filter((m) => m.includes("PAUSED"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/Antigravity reviewer's login was rejected/);
    expect(paused[0]).toMatch(/sudo -u antigravity -i/);
    expect(paused[0]).not.toMatch(/Claude/);
    expect(agyLog("calls")).toHaveLength(0);
    expect(existsSync(join(ghDir, "calls.log")) && ghCalls().includes("pr checkout 56 --force")).toBe(false);
  });

  it("a used-up quota pauses it once, saying whose quota", () => {
    const quota = "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s.";
    sweep({ preflight: quota, preflightRc: 1 });
    sweep({ preflight: quota, preflightRc: 1 });

    const paused = sent().filter((m) => m.includes("PAUSED"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/Antigravity reviewer's quota is used up/);
    expect(paused[0]).toContain("Resets in 57h37m44s");
  });

  it("the preflight's own stray output (a model list, a TTY error) is NOT 'Claude preflight failed': it says what the reviewer printed", () => {
    sweep({ preflight: "bubbletea: error opening TTY: could not open TTY: open /dev/tty: no such device or address", preflightRc: 1 });

    const paused = sent().filter((m) => m.includes("PAUSED"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/Antigravity reviewer's preflight failed \(bubbletea/);
    expect(paused[0]).not.toMatch(/Claude/);
  });

  it("a quota wall in the middle of a review pauses the sweep too (and the PR is not counted as failed)", () => {
    sweep({ agyOut: "", agyErr: "error: Individual quota reached. Resets in 2h.\n", agyRc: 1 });

    expect(sent().filter((m) => m.includes("PAUSED"))).toHaveLength(1);
    expect(sent().filter((m) => m.includes("Gate FAILED to complete"))).toHaveLength(0);
    expect(existsSync(join(home, ".claude", "pr-brain.down"))).toBe(true);
  });

  it("one 'resumed' message when a later sweep reaches the reviewer again", () => {
    sweep({ preflight: "Error: authentication timed out.", preflightRc: 1 });
    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    const resumed = sent().filter((m) => m.includes("resumed"));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatch(/the Antigravity reviewer reachable again/);
  });
});

describe("a reviewer model that is out of quota (quota is per model family: the next model reviews)", () => {
  const SPENT = "claude-sonnet-4-6";
  const FALLBACK = "gemini-3.1-pro-high";

  it("at the preflight: the first model is spent, so the review runs on the next one — no pause, no 'failed' message", () => {
    const r = sweep({ agyOut: review("All good.\n\nBRAIN-VERDICT: PASS"), env: { AGY_PREFLIGHT_QUOTA_MODELS: SPENT } });

    expect(r.status).toBe(0);
    expect(agyLog("pf-models")).toEqual([SPENT, FALLBACK]);
    expect(agyLog("model")).toEqual([FALLBACK]);
    expect(ghState("draft")).toBe("false");
    expect(sent().filter((m) => /PAUSED|FAILED/.test(m))).toHaveLength(0);
    expect(existsSync(join(home, ".claude", "pr-brain.down"))).toBe(false);
    expect(prBrainLog()).toMatch(/quota used up on claude-sonnet-4-6 \(.*Resets in 69h26m28s.*\): trying the next reviewer model/);
    expect(prBrainLog()).toMatch(/engine=agy model=gemini-3\.1-pro-high/);
  });

  it("in the middle of a review (the 2026-10-02 shape): the same PR is reviewed again on the next model, in the same attempt", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { AGY_REVIEW_QUOTA_MODELS: SPENT } });

    expect(agyLog("model")).toEqual([SPENT, FALLBACK]);
    expect(ghState("draft")).toBe("false");
    expect(sent().filter((m) => /PAUSED|FAILED/.test(m))).toHaveLength(0);
    expect(existsSync(join(home, ".claude", "pr-brain.failures"))).toBe(false);
    expect(prBrainLog()).toMatch(/oplify-messaging-api#56: quota used up on claude-sonnet-4-6 .*: reviewing again with gemini-3\.1-pro-high/);
    // the founder's progress message for the first run says why it stopped and what happens next
    expect(edits().some((t) => t.includes("claude-sonnet-4-6 has no quota left. Reviewing again with gemini-3.1-pro-high."))).toBe(true);
  });

  it("a spent model stays spent for the rest of the sweep: the next PR goes straight to the fallback", () => {
    const bare = join(root, "github", `${SLUG}.git`);
    const seed = join(root, "seed");
    writeFileSync(join(seed, "second.txt"), "work 2\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "work 2");
    const head2 = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", bare, "task/issue-72-x");
    git(bare, "update-ref", "refs/pull/57/head", head2);

    sweep({ prs: `56 ${head}\n57 ${head2}`, agyOut: review("BRAIN-VERDICT: FAIL"), env: { AGY_REVIEW_QUOTA_MODELS: SPENT } });

    expect(agyLog("pf-models")).toEqual([SPENT]);
    expect(agyLog("model")).toEqual([SPENT, FALLBACK, FALLBACK]);
  });

  it("every model spent at the preflight: ONE pause message naming the models tried and the reset time, and no review runs", () => {
    const env = { AGY_PREFLIGHT_QUOTA_MODELS: `${SPENT} ${FALLBACK}` };
    sweep({ env });
    sweep({ env });

    const paused = sent().filter((m) => m.includes("PAUSED"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/Antigravity reviewer's quota is used up \(tried claude-sonnet-4-6, gemini-3\.1-pro-high: .*Resets in 69h26m28s/);
    expect(agyLog("calls")).toHaveLength(0);
    expect(existsSync(join(home, ".claude", "pr-brain.down"))).toBe(true);
  });

  it("every model spent in the middle of a review, behind ~100 lines of narration: a PAUSE, not 'failed attempt 1/3'", () => {
    sweep({ env: { AGY_REVIEW_QUOTA_MODELS: `${SPENT} ${FALLBACK}` } });

    expect(agyLog("model")).toEqual([SPENT, FALLBACK]);
    expect(sent().filter((m) => m.includes("PAUSED"))).toHaveLength(1);
    expect(sent().filter((m) => m.includes("Gate FAILED"))).toHaveLength(0);
    expect(prBrainLog()).not.toMatch(/gate FAILED/);
    expect(existsSync(join(home, ".claude", "pr-brain.failures"))).toBe(false);
    expect(existsSync(join(home, ".claude", "pr-brain.down"))).toBe(true);
  });

  it("a rejected login is NOT tried on the next model: every model shares the login", () => {
    sweep({ preflight: "Error: authentication timed out.", preflightRc: 1 });

    expect(agyLog("pf-models")).toEqual([SPENT]);
    expect(sent().filter((m) => m.includes("PAUSED"))).toHaveLength(1);
  });

  it("never reviews with the executor's own model, even when the list names it first", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { PR_BRAIN_MODELS: "gemini-3.6-flash-medium,gemini-3.1-pro-high" } });

    expect(agyLog("pf-models")).toEqual([FALLBACK]);
    expect(agyLog("model")).toEqual([FALLBACK]);
  });

  it("pauses, and says why, when the only configured model IS the executor's", () => {
    sweep({ env: { PR_BRAIN_MODELS: "gemini-3.6-flash-medium" } });

    const paused = sent().filter((m) => m.includes("PAUSED"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/no reviewer model is configured that differs from the executor model gemini-3\.6-flash-medium/);
    expect(agyLog("pf-models")).toHaveLength(0);
    expect(agyLog("calls")).toHaveLength(0);
  });

  it("follows the executor when it is moved: AGENT_DISPATCH_MODEL is what agent-dispatch runs, so it is what is off limits", () => {
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { AGENT_DISPATCH_MODEL: SPENT } });

    expect(agyLog("model")).toEqual([FALLBACK]);
  });
});

describe("a long comment thread must not hide the marker (`cmd | grep -q` under pipefail reads SIGPIPE as 'not found')", () => {
  // grep -q stops at the first hit; the writer, still writing, is killed by SIGPIPE; pipefail turns that into a failed
  // pipeline, and `if ! …` read it as "no marker". Seen on 2026-10-02 as a duplicate marker, once in six runs of the
  // test on a loaded machine; with a real PR thread (review bodies, evidence packs) it needs no load at all.
  const BIG = "filler line, a long review body would be here .......\n".repeat(6000);

  it("an already-gated head is skipped however long the PR's thread is: no second review is spent", () => {
    writeFileSync(join(ghDir, "comments"), `<!-- brain-reviewed: ${head} -->\n${BIG}`);

    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    expect(agyLog("calls")).toHaveLength(0);
    expect(prBrainLog()).toMatch(/oplify-messaging-api#56 already gated at .* skipped/);
  });

  it("the runner does not post a second marker when the head is already stamped, even while gh is still writing after the marker", () => {
    // gh prints the marker and keeps writing: grep -q stops at the marker, the writer dies of SIGPIPE (141).
    sweep({
      agyOut: review("ok\nBRAIN-VERDICT: PASS"),
      agyHook: `gh pr comment 56 --body "<!-- brain-reviewed: ${head} -->"`,
      env: { GH_SLOW_TAIL: "1" },
    });

    expect(ghState("comments").split("\n").filter((l) => l.includes(`brain-reviewed: ${head}`))).toHaveLength(1);
  });
});

describe("configuration", () => {
  it("an unknown engine is refused before anything runs", () => {
    const r = sweep({ env: { PR_BRAIN_ENGINE: "gpt" } });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PR_BRAIN_ENGINE must be agy or claude/);
    expect(existsSync(join(ghDir, "calls.log"))).toBe(false);
  });

  /** A repo that is OURS (not an employer org), whose PRs target beta: the case pr-brain merges and promotes. */
  const makeRepoOurs = (): void => {
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/owner/oplify-messaging-api.git"], { cwd: join(root, "repos", "oplify-messaging-api") });
    cpSync(join(root, "github", "OplifyMessage"), join(root, "github", "owner"), { recursive: true });
  };

  it("control: a cleared PR on our own repo's beta IS squash-merged (which is why the next test needs a knob)", () => {
    makeRepoOurs();
    sweep({ agyOut: review("BRAIN-VERDICT: PASS") });

    expect(ghCalls().some((c) => c.startsWith("pr merge 56 --squash"))).toBe(true);
  });

  it("PR_BRAIN_MERGE=0 clears the PR but never merges or promotes it (reviewing a change to this loop without deploying it)", () => {
    makeRepoOurs();
    sweep({ agyOut: review("BRAIN-VERDICT: PASS"), env: { PR_BRAIN_MERGE: "0" } });

    expect(ghState("draft")).toBe("false"); // still cleared
    expect(ghCalls().some((c) => c.startsWith("pr merge"))).toBe(false);
    expect(ghCalls().some((c) => c.startsWith("pr create"))).toBe(false);
    expect(prBrainLog()).toMatch(/cleared — merge withheld \(PR_BRAIN_MERGE=0\)/);
    expect(sent().find((m) => m.startsWith("🧠 Gate done"))).toMatch(/Merge: not attempted — PR_BRAIN_MERGE=0/);
  });

  it("--dry-run lists what it would gate and starts nothing", () => {
    const r = sweep({ args: ["--dry-run"] });

    expect(r.status).toBe(0);
    expect(prBrainLog()).toMatch(/DRY RUN would gate oplify-messaging-api#56/);
    expect(agyLog("calls")).toHaveLength(0);
    expect(sent()).toEqual([]);
  });

  it("the Claude engine stays selectable and never reaches agy", () => {
    sweep({ env: { PR_BRAIN_ENGINE: "claude" } });

    expect(claudeCalls()).toBeGreaterThan(0);
    expect(agyLog("calls")).toHaveLength(0);
  });
});
