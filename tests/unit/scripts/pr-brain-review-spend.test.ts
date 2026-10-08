/**
 * pr-brain — what a review is NOT spent on. deploy/vps-daemons/pr-brain, run against stub gh, sudo, agy and curl.
 * ==============================================================================================================
 * A review is a full agy session on a quota the executor shares (Gemini flash and pro are one window), 3 to 10
 * minutes and 60+ tool calls each. A 2026-10-03 audit of the sweep found three reviews it should not have started:
 *
 *   1. A promotion PR (beta -> main, main -> beta). The work in it passed its own gate when it went into beta; the
 *      house rule is "no new review on a promotion". Oplify api#60 and app#41 each got a ~4 minute review anyway.
 *   2. A PR whose required CI is red (founderos#791 was reviewed on four heads while "Unit + regression tests" failed).
 *      The review cannot clear it and the executor has to fix it either way: pr-brain skips it, and agent-dispatch
 *      (tests/unit/scripts/agent-dispatch-ci-red.test.ts) sends the executor back with the failing check as the brief.
 *   3. Any review past a day's worth. Nothing bounded the total: a loop that re-opens heads (or a flapping check)
 *      kept paying until the quota was gone, and the executor lives on the same quota.
 *
 * Each rule is pinned from the outside: no agy call at all, no preflight, and what the founder is told.
 * `--pr N` is an explicit order and is never held back by any of them.
 *
 * A fourth rule is the founder's decision of 2026-10-05: a sweep reviews only PIPELINE PRs, the ones from the issue
 * queue (head branch task/issue-*) and any PR carrying the label claude-review. Everything else is skipped before a
 * single review is spent, with one log line.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));
const SLUG = "pushkarverma3698/FounderOS";
const NOW = 1_790_000_000; // a fixed "now" so the 24 hour window is exact
const DAY = 86_400;

let root: string;
let home: string;
let bin: string;
let ghDir: string;
let head: string;

const PASS_REVIEW = JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "ok\n\nBRAIN-VERDICT: PASS", duration_seconds: 9, num_turns: 3 } }) + "\n";
const RED = JSON.stringify([
  { bucket: "fail", name: "Unit + regression tests" },
  { bucket: "pass", name: "Type check + lint + wiring" },
]);
const GREEN = JSON.stringify([
  { bucket: "pass", name: "Unit + regression tests" },
  { bucket: "pass", name: "Type check + lint + wiring" },
]);
const PENDING = JSON.stringify([
  { bucket: "pending", name: "Unit + regression tests" },
  { bucket: "pass", name: "Type check + lint + wiring" },
]);

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

interface SweepOptions {
  readonly env?: Record<string, string>;
  readonly args?: readonly string[];
  /** The open PRs as the gh stub lists them: "<number> <head sha> <base branch> <head branch> <labels, comma-joined>". */
  readonly prs?: string;
}

function sweep(opts: SweepOptions = {}): { status: number | null; stdout: string } {
  const r = spawnSync("bash", [SCRIPT, ...(opts.args ?? [])], {
    env: {
      TG_QUIET_NOW: "12", // daytime: notify must not depend on when CI runs
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
      HOME: home,
      PR_BRAIN_ROOT: join(root, "repos"),
      PR_BRAIN_ENV_FILE: join(root, ".env"),
      PR_BRAIN_OWNER: "pushkarverma3698",
      PR_BRAIN_REVIEW_WORKSPACES: join(root, "review-ws"),
      PR_BRAIN_GITHUB_URL: join(root, "github"),
      PR_BRAIN_SKILL_FILE: join(root, "SKILL.md"),
      PR_BRAIN_PROGRESS_POLL_SEC: "0",
      PR_BRAIN_NOW_EPOCH: String(NOW),
      QA_APP_ROOT: join(root, "no-founderos"),
      GH_DIR: ghDir,
      FAKE_HEAD: head,
      PR_LIST: opts.prs ?? `56 ${head} beta task/issue-72-x`,
      AGY_OUT: PASS_REVIEW,
      AGY_LOGS: join(root, "agy"),
      SENDS: join(root, "sends.log"),
      ...opts.env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout };
}

const sent = (): string[] => {
  const f = join(root, "sends.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n@@\n")
    .filter((s) => s.trim() !== "")
    .map((rec) => rec.slice(rec.indexOf("\t") + 1));
};
const notices = (prefix: string): string[] => sent().filter((m) => m.startsWith(prefix));
const ghState = (name: string): string => (existsSync(join(ghDir, name)) ? readFileSync(join(ghDir, name), "utf8").trim() : "");
const ghCalls = (): string[] => (existsSync(join(ghDir, "calls.log")) ? readFileSync(join(ghDir, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
const agyLog = (name: string): string[] => {
  const f = join(root, "agy", name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const prBrainLog = (): string => readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");
const reviews = (): number => agyLog("calls").length;
const setChecks = (json: string, rc = 0): void => {
  writeFileSync(join(ghDir, "checks"), json);
  writeFileSync(join(ghDir, "checks.rc"), String(rc));
};
/** The executor (or the founder) pushes one more commit to the PR branch: the new head, as GitHub would show it. */
function pushNewHead(name: string): string {
  const bare = join(root, "github", `${SLUG}.git`);
  const seed = join(root, "seed");
  writeFileSync(join(seed, `${name}.txt`), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", name);
  const moved = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", bare, "task/issue-72-x");
  git(bare, "update-ref", "refs/pull/56/head", moved);
  head = moved;
  return moved;
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-spend-"));
  home = join(root, "home");
  bin = join(root, "bin");
  ghDir = join(root, "gh");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(root, "agy"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\nGITHUB_TOKEN=test-github-token\n");
  writeFileSync(join(ghDir, "draft"), "true\n");
  writeFileSync(join(root, "SKILL.md"), "---\nname: pr-adversary\ndescription: x\n---\n\n# Adversarial PR Gate\n");

  // The repository pr-brain sweeps (our own: a cleared PR is MERGED, so every test below that expects "no review"
  // would also have been merged and promoted without these rules) and the "GitHub" its review clone comes from.
  const bare = join(root, "github", `${SLUG}.git`);
  mkdirSync(join(root, "github", "pushkarverma3698"), { recursive: true });
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

  const repo = join(root, "repos", "FounderOS");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${SLUG}.git`], { cwd: repo });

  // `pr checks` answers like gh 2.63: JSON on stdout; for a base branch with no required checks a sentence and rc 1.
  stub(
    "gh",
    `echo "$*" >>"$GH_DIR/calls.log"
case "$*" in
  "api user"*) echo pushkarverma3698 ;;
  "auth status"*) exit 0 ;;
  "pr list"*) [ -n "$PR_LIST" ] && echo "$PR_LIST" ;;
  "pr checkout "*) exit 0 ;;
  "pr checks "*) cat "$GH_DIR/checks" 2>/dev/null; exit "$(cat "$GH_DIR/checks.rc" 2>/dev/null || echo 0)" ;;
  "pr ready "*"--undo"*) echo true >"$GH_DIR/draft" ;;
  "pr ready "*) echo false >"$GH_DIR/draft" ;;
  "pr comment "*) body=""; while [ $# -gt 0 ]; do [ "$1" = "--body" ] && body="$2"; shift; done; printf '%s\\n' "$body" >>"$GH_DIR/comments" ;;
  *"app-evidence"*) : ;;
  *"--json comments"*) cat "$GH_DIR/comments" 2>/dev/null ;;
  *"headRefOid"*) echo "$FAKE_HEAD" ;;
  *"--json isDraft --jq .isDraft"*) cat "$GH_DIR/draft" ;;
  *"reviewDecision"*) if [ "$(cat "$GH_DIR/draft")" = true ]; then echo "REVIEWED, left as draft — not cleared · feat: x"; else echo "CLEARED — marked ready for merge (self-approval impossible; ready IS the pass) · feat: x"; fi ;;
  *"baseRefName"*) echo beta ;;
  *"--json url"*) echo "https://github.com/${SLUG}/pull/56" ;;
  *) exit 0 ;;
esac`,
  );
  stub("sudo", `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
  stub("timeout", `shift; exec "$@"`);
  stub(
    "agy",
    `model=""; prev=""
for a in "$@"; do [ "$prev" = "--model" ] && model="$a"; prev="$a"; done
case "$*" in *"reply with the single word ok"*) echo "$model" >>"$AGY_LOGS/pf-models"; echo ok; exit 0 ;; esac
echo review >>"$AGY_LOGS/calls"
printf '%s' "$AGY_OUT"`,
  );
  stub("claude", `exit 1`);
  stub(
    "curl",
    `kind=""; text=""
for a in "$@"; do case "$a" in
  */sendMessage) kind=send ;;
  */editMessageText) kind=edit ;;
  text=*) text="\${a#text=}" ;;
esac; done
[ "$kind" = send ] && printf '%s\\t%s\\n@@\\n' "$kind" "$text" >>"$SENDS"
printf '{"ok":true,"result":{"message_id":7}}\\n'`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a promotion PR is not reviewed again", () => {
  it("beta -> main: no agy call, not even the preflight, no marker, no merge attempt, and the log says why", () => {
    const r = sweep({ prs: `60 ${head} main beta` });

    expect(r.status).toBe(0);
    expect(reviews()).toBe(0);
    expect(agyLog("pf-models")).toEqual([]);
    expect(ghState("comments")).toBe("");
    expect(ghCalls().filter((c) => c.startsWith("pr merge"))).toEqual([]);
    expect(prBrainLog()).toMatch(/FounderOS#60 is a promotion\/sync PR \(beta → main\)/);
  });

  it("main -> beta (the sync PR) and a chore/promote-* branch are the same case", () => {
    sweep({ prs: `61 ${head} beta main\n62 ${head} main chore/promote-loop-followup` });

    expect(reviews()).toBe(0);
    expect(prBrainLog()).toMatch(/#61 is a promotion\/sync PR/);
    expect(prBrainLog()).toMatch(/#62 is a promotion\/sync PR/);
  });

  it("an ordinary task PR on the same sweep IS still reviewed (the rule is about the head branch, not the sweep)", () => {
    sweep({ prs: `60 ${head} main beta\n56 ${head} beta task/issue-72-x` });

    expect(reviews()).toBe(1);
    expect(ghState("comments")).toContain(`brain-reviewed: ${head}`);
  });

  it("--pr is an explicit order: a promotion PR named on the command line is reviewed", () => {
    sweep({ args: ["--pr", "56", "--repo", join(root, "repos", "FounderOS")], prs: `56 ${head} main beta` });

    expect(reviews()).toBe(1);
  });
});

describe("only pipeline PRs are reviewed", () => {
  it("a task/issue-* branch is a pipeline PR: reviewed", () => {
    sweep({ prs: `56 ${head} beta task/issue-12-x` });

    expect(reviews()).toBe(1);
    expect(ghState("comments")).toContain(`brain-reviewed: ${head}`);
  });

  it("any other branch is skipped silently before any review spend, with one log line", () => {
    const r = sweep({ prs: `70 ${head} beta feat/foo` });

    expect(r.status).toBe(0);
    expect(reviews()).toBe(0);
    expect(agyLog("pf-models")).toEqual([]);
    expect(ghState("comments")).toBe("");
    expect(sent()).toEqual([]);
    expect(ghCalls().filter((c) => c.startsWith("pr merge") || c.startsWith("pr ready"))).toEqual([]);
    expect(prBrainLog().match(/FounderOS#70 is not a pipeline PR/g)).toHaveLength(1);
  });

  it("the same branch carrying the label claude-review is reviewed", () => {
    sweep({ prs: `56 ${head} beta feat/foo bug,claude-review` });

    expect(reviews()).toBe(1);
    expect(ghState("comments")).toContain(`brain-reviewed: ${head}`);
  });

  it("a different label does not opt a PR in, and a label that merely contains the word does not either", () => {
    sweep({ prs: `70 ${head} beta feat/foo engine:claude,not-claude-review` });

    expect(reviews()).toBe(0);
    expect(prBrainLog()).toMatch(/FounderOS#70 is not a pipeline PR/);
  });

  it("--pr is an explicit order: it reviews a non-pipeline branch", () => {
    sweep({ args: ["--pr", "56", "--repo", join(root, "repos", "FounderOS")], prs: `56 ${head} beta feat/foo` });

    expect(reviews()).toBe(1);
    expect(prBrainLog()).not.toMatch(/not a pipeline PR/);
  });

  it("the promotion skip still comes first and keeps its own reason, even with the label", () => {
    sweep({ prs: `60 ${head} main chore/promote-x claude-review` });

    expect(reviews()).toBe(0);
    expect(prBrainLog()).toMatch(/#60 is a promotion\/sync PR/);
    expect(prBrainLog()).not.toMatch(/not a pipeline PR/);
  });

  it("the sweep asks gh for the labels in the same list call", () => {
    sweep({ prs: `56 ${head} beta task/issue-12-x` });

    const list = ghCalls().find((c) => c.startsWith("pr list")) ?? "";
    expect(list).toMatch(/--json [^ ]*labels/);
    // the jq program spans several lines of the call log: the label names are joined into the one printed row
    expect(ghCalls().some((c) => c.includes("[.labels[].name] | join("))).toBe(true);
  });
});

describe("a PR whose required CI is red is not reviewed", () => {
  it("the executor's draft: no agy call, no marker (agent-dispatch acts on the red check itself), nothing sent: agent-dispatch speaks", () => {
    setChecks(RED);

    sweep();

    expect(reviews()).toBe(0);
    expect(agyLog("pf-models")).toEqual([]);
    expect(ghState("draft")).toBe("true");
    expect(ghState("comments")).toBe("");
    expect(sent()).toEqual([]);
    expect(prBrainLog()).toMatch(/FounderOS#56 head \w{8}: required CI is red \(Unit \+ regression tests\) — no review spent/);
  });

  it("repeats nothing: every later sweep skips it the same way, with no marker and no message", () => {
    setChecks(RED);
    sweep();
    sweep();
    sweep();

    expect(reviews()).toBe(0);
    expect(ghState("comments")).toBe("");
    expect(sent()).toEqual([]);
  });

  it("a push that turns CI green is reviewed on the next sweep; nothing stale is left behind", () => {
    setChecks(RED);
    sweep();
    expect(reviews()).toBe(0);

    const fixed = pushNewHead("fix");
    setChecks(GREEN);
    sweep({ prs: `56 ${fixed} beta task/issue-72-x`, env: { FAKE_HEAD: fixed } });

    expect(reviews()).toBe(1);
    expect(existsSync(join(home, ".claude", "pr-brain.ci", "FounderOS#56"))).toBe(false);
  });

  it("the SAME head going green (a flaky check re-run) is reviewed too: red leaves no stamp that would block it", () => {
    setChecks(RED);
    sweep();
    setChecks(GREEN);

    sweep();

    expect(reviews()).toBe(1);
  });

  it("anyone else's PR has nobody acting on it, so the founder is told, once per head, and nothing is changed", () => {
    setChecks(RED);
    const prs = `70 ${head} beta feat/mine claude-review`;

    sweep({ prs });
    sweep({ prs });

    expect(reviews()).toBe(0);
    expect(notices("⏭")).toHaveLength(1);
    expect(notices("⏭")[0]).toMatch(/FounderOS#70: its required CI is red \(Unit \+ regression tests\)\. No review spent; nothing was changed\./);
    expect(ghState("comments")).toBe("");
    expect(ghState("draft")).toBe("true");
  });

  it("a PR that is already ready is neither reviewed nor turned back into a draft", () => {
    writeFileSync(join(ghDir, "draft"), "false\n");
    setChecks(RED);

    sweep({ prs: `70 ${head} beta task/issue-70-x` });

    expect(reviews()).toBe(0);
    expect(ghState("draft")).toBe("false");
    expect(ghCalls().filter((c) => c.includes("--undo"))).toEqual([]);
  });

  it("a new head on that PR is told about again (the notice is per head)", () => {
    setChecks(RED);
    sweep({ prs: `70 ${head} beta feat/mine claude-review` });
    const next = pushNewHead("again");

    sweep({ prs: `70 ${next} beta feat/mine claude-review`, env: { FAKE_HEAD: next } });

    expect(notices("⏭")).toHaveLength(2);
  });

  it("only REQUIRED checks count: the CI query asks for them (a failing staging deploy is not a failing PR)", () => {
    setChecks(GREEN);

    sweep();

    expect(ghCalls().find((c) => c.startsWith("pr checks 56"))).toMatch(/--required/);
    expect(reviews()).toBe(1);
  });

  it("--pr is an explicit order: it reviews a red PR", () => {
    setChecks(RED);

    sweep({ args: ["--pr", "56", "--repo", join(root, "repos", "FounderOS")] });

    expect(reviews()).toBe(1);
  });
});

describe("a PR whose required CI is still running waits, boundedly", () => {
  it("is deferred without a marker or a message, and reviewed anyway once it has waited PR_BRAIN_CI_WAIT_SWEEPS sweeps", () => {
    setChecks(PENDING);
    const env = { PR_BRAIN_CI_WAIT_SWEEPS: "2" };

    sweep({ env });
    sweep({ env });
    expect(reviews()).toBe(0);
    expect(ghState("comments")).toBe("");
    expect(sent()).toEqual([]);
    expect(prBrainLog()).toMatch(/required CI still running — review deferred \(1\/2\)/);
    expect(prBrainLog()).toMatch(/\(2\/2\)/);

    sweep({ env }); // a check that never finishes must not hold a PR forever
    expect(reviews()).toBe(1);
    expect(prBrainLog()).toMatch(/still running after 2 sweeps — reviewing anyway/);
  });

  it("the wait restarts on a new head (it is counted per head, not per PR)", () => {
    setChecks(PENDING);
    const env = { PR_BRAIN_CI_WAIT_SWEEPS: "1" };
    sweep({ env });
    expect(prBrainLog()).toMatch(/\(1\/1\)/);

    const moved = pushNewHead("more");
    sweep({ prs: `56 ${moved} beta task/issue-72-x`, env: { ...env, FAKE_HEAD: moved } });

    expect(reviews()).toBe(0);
    expect((prBrainLog().match(/\(1\/1\)/g) ?? []).length).toBe(2);
  });
});

describe("when CI says nothing usable the review is spent as before (the quiet failure must not be 'never review')", () => {
  it("no required checks on the base branch (gh prints a sentence and exits 1)", () => {
    setChecks("no required checks reported on the 'beta' branch\n", 1);

    sweep();

    expect(reviews()).toBe(1);
  });

  it("gh failing or printing garbage", () => {
    setChecks("GraphQL: something broke\n", 1);

    sweep();

    expect(reviews()).toBe(1);
  });

  it("an empty list", () => {
    setChecks("[]");

    sweep();

    expect(reviews()).toBe(1);
  });
});

describe("a daily ceiling on reviews", () => {
  const ledger = (...agesSec: number[]): void => {
    writeFileSync(join(home, ".claude", "pr-brain.reviews"), agesSec.map((a, i) => `${NOW - a} FounderOS#${10 + i} deadbeef`).join("\n") + "\n");
  };

  it("at the ceiling no review starts, the sweep stops, and the founder is told once a day, with how to override", () => {
    ledger(60, 600, 3_600);
    const env = { PR_BRAIN_DAILY_MAX: "3" };

    sweep({ env });
    sweep({ env });

    expect(reviews()).toBe(0);
    expect(agyLog("pf-models")).toEqual([]);
    expect(notices("🧯")).toHaveLength(1);
    expect(notices("🧯")[0]).toMatch(/3 reviews in the last 24 h/);
    expect(notices("🧯")[0]).toMatch(/PR_BRAIN_DAILY_MAX/);
    expect(notices("🧯")[0]).toMatch(/pr-brain --pr/);
    expect(prBrainLog()).toMatch(/daily review ceiling reached \(3 in 24 h, PR_BRAIN_DAILY_MAX=3\)/);
  });

  it("the notice comes again the next day (the ceiling still holds: three fresh reviews)", () => {
    ledger(60, 600, 3_600);
    const env = { PR_BRAIN_DAILY_MAX: "3" };
    sweep({ env });

    const tomorrow = NOW + DAY + 200;
    writeFileSync(join(home, ".claude", "pr-brain.reviews"), [1, 2, 3].map((i) => `${tomorrow - i} FounderOS#${i} deadbeef`).join("\n") + "\n");
    sweep({ env: { ...env, PR_BRAIN_NOW_EPOCH: String(tomorrow) } });

    expect(reviews()).toBe(0);
    expect(notices("🧯")).toHaveLength(2);
  });

  it("reviews older than 24 hours do not count", () => {
    ledger(DAY + 10, DAY + 20, DAY + 30);

    sweep({ env: { PR_BRAIN_DAILY_MAX: "3" } });

    expect(reviews()).toBe(1);
  });

  it("every review is written to the ledger, and the ledger keeps only the last 24 hours", () => {
    ledger(DAY + 500, 120);

    sweep({ env: { PR_BRAIN_DAILY_MAX: "50" } });

    const lines = readFileSync(join(home, ".claude", "pr-brain.reviews"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`${NOW - 120} FounderOS#11 deadbeef`);
    expect(lines[1]).toBe(`${NOW} FounderOS#56 ${head.slice(0, 8)}`);
  });

  it("a review that FAILED to finish still counts: it spent the quota", () => {
    sweep({ env: { PR_BRAIN_DAILY_MAX: "1", AGY_OUT: "no verdict here\n" } });
    expect(reviews()).toBe(1);

    sweep({ env: { PR_BRAIN_DAILY_MAX: "1", AGY_OUT: "no verdict here\n" } });
    expect(reviews()).toBe(1);
    expect(notices("🧯")).toHaveLength(1);
  });

  it("PR_BRAIN_DAILY_MAX=0 turns the ceiling off", () => {
    ledger(60, 600, 3_600, 7_200);

    sweep({ env: { PR_BRAIN_DAILY_MAX: "0" } });

    expect(reviews()).toBe(1);
  });

  it("--pr is an explicit order: it reviews at the ceiling (and still counts)", () => {
    ledger(60, 600, 3_600);

    sweep({ args: ["--pr", "56", "--repo", join(root, "repos", "FounderOS")], env: { PR_BRAIN_DAILY_MAX: "3" } });

    expect(reviews()).toBe(1);
    expect(readFileSync(join(home, ".claude", "pr-brain.reviews"), "utf8").split("\n").filter(Boolean)).toHaveLength(4);
  });

  it("the ceiling stops the sweep: a promotion PR and a red PR listed first do not use it up, a later PR waits", () => {
    ledger(60, 600, 3_600);
    setChecks(GREEN);

    sweep({ prs: `60 ${head} main beta\n56 ${head} beta task/issue-72-x`, env: { PR_BRAIN_DAILY_MAX: "3" } });

    expect(reviews()).toBe(0);
    expect(notices("🧯")).toHaveLength(1);
  });

  it("--dry-run reads the ledger and writes nothing", () => {
    ledger(60);

    sweep({ args: ["--dry-run"], env: { PR_BRAIN_DAILY_MAX: "1" } });

    expect(reviews()).toBe(0);
    expect(readFileSync(join(home, ".claude", "pr-brain.reviews"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(sent()).toEqual([]);
  });
});
