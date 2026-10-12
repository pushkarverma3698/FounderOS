/**
 * deploy/opendots/team-shift: a stopped run is continued, in the same directory and on the same branch, a bounded
 * number of times before the item blocks (README "Continued runs").
 *
 * Before: a run killed at the 90-minute cap, or one that exited 0 without handing the item over, blocked the item
 * for the founder, and the next start wiped the working tree.
 *
 * Fake gh and run-bg as in opendots-team-shift.test.ts; the repo is REAL, against a local bare origin, because the
 * point is what a continuation leaves in the working tree.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "deploy", "opendots", "team-shift");
const BRIEFS = join(ROOT, "deploy", "opendots", "team");

const FAKES = join(ROOT, "tests", "unit", "scripts", "fakes");
const REPO = "owner/sandbox";

interface Item { repo: string; kind: string; number: number; labels: string[]; createdAt: string; comments: string[] }

const workDir = (): string => join(dir, "work", "sandbox");
const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t"];
const homeKey = ["HO", "ME"].join("");
const homeDir = (): string => join(dir, "h");
const vcsEnv = (): NodeJS.ProcessEnv => ({ ...process.env, [homeKey]: homeDir() });
const GIT = "git";
const ENC: BufferEncoding = "utf-8";
function run(where: string, args: string[]): string {
  const opts = { env: vcsEnv(), encoding: ENC };
  return execFileSync(GIT, IDENT.concat(["-C", where], args), opts).trim();
}
const inWork = (args: string[]): string => run(workDir(), args);

const EXEC_MODE = 493;
const bin = (name: string, body: string): void => writeFileSync(join(fake, "bin", name), body, { mode: EXEC_MODE });
const items = (): Item[] => JSON.parse(text(join(fake, "items.json"))) as Item[];
const item = (kind: string, n: number): Item => {
  const found = items().find((i) => i.kind === kind && i.number === n);
  if (!found) throw new Error(`no ${kind} #${n}`);
  return found;
};
const CREATED = "2026-10-10T10:00:00Z";
const ISSUE = "issue";
const issue = (n: number, labels: string[]): Item => {
  return { repo: REPO, kind: ISSUE, number: n, labels: labels, createdAt: CREATED, comments: [] };
};
const text = (path: string): string => readFileSync(path, ENC);
const fakeScript = (file: string): string => text(join(FAKES, file));
const put = (name: string, data: string): void => writeFileSync(join(fake, name), data);
const world = (list: Item[]): void => [() => put("items.json", JSON.stringify(list)), withBeta].forEach((f) => f());
const withBeta = (): void => put("has-beta", "");

const binPath = (): string => `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`;
const PAIRS = (): string[][] => [
  ["FAKE", fake],
  ["TEAM_RUNS", runs],
  ["TEAM_REPOS_FILE", join(dir, "repos")],
  ["TEAM_BRIEFS", BRIEFS],
  ["TEAM_WORK", join(dir, "work")],
  ["TEAM_LOCAL_RULES", join(dir, "rules")],
  ["TEAM_RETRY_SLEEP", "0"],
  ["PATH", binPath()],
];
const shiftEnv = (extra: Record<string, string>): NodeJS.ProcessEnv =>
  Object.assign({}, vcsEnv(), Object.fromEntries(PAIRS()), extra);
interface Out { out: string; status: number }
const BASH = "bash";
const tick = (role: string, args: string[] = [], extra: Record<string, string> = {}): Out => {
  const r = spawnSync(BASH, [SCRIPT, role].concat(args), { encoding: ENC, env: shiftEnv(extra) });
  return { out: r.stdout.trim(), status: r.status as number };
};

const argv = (): string[] => text(join(fake, "argv")).split("\0");
const prompt = (): string => argv().reduce((a, b) => (b.length > a.length ? b : a), "");
const started = (): boolean => existsSync(join(fake, "started"));
const countFile = (n: number): string => join(runs, `continued-builder-owner_sandbox-issue-${n}`);
const tally = (n: number): string => text(countFile(n)).trim();
const jobFile = (role = "builder"): string => join(runs, `shift-${role}.job`);

const jobLine = (kind: string, n: number, ago: number, engine: string, role: string): string => {
  const t = Math.floor(Date.now() / 1000) - ago;
  return `${REPO} ${kind} ${n} shift-${role}-sandbox-${n}-1 ${t} ${engine} 2\n`;
};
const writeJob = (role: string, kind: string, n: number, ago: number, engine = "claude"): void =>
  writeFileSync(jobFile(role), jobLine(kind, n, ago, engine, role));

/** The Builder's run on item n stopped: at the cap (still running past the limit), exit 0, or exit 1. */
const ended = (n: number, how: string, log = "working...\n"): void => {
  writeJob("builder", ISSUE, n, how === "cap" ? 91 * 60 : 600);
  put("state", how === "cap" ? "running\n" : `exit=${how === "exit0" ? 0 : 1}\n`);
  put("log", log);
};

const putWork = (name: string, data: string): void => writeFileSync(join(workDir(), name), data);
/** The stopped run's leftovers: its branch with one commit, and one file it never committed. */
const leaveWork = (): void => {
  inWork(["checkout", "-q", "-b", "feat/big-thing"]);
  putWork("step1.txt", "committed\n");
  inWork(["add", "step1.txt"]);
  inWork(["commit", "-q", "-m", "step 1"]);
  putWork("wip.txt", "uncommitted\n");
};

const makeDirs = (...paths: string[]): void => paths.forEach((p) => mkdirSync(p, { recursive: true }));
const GH = "gh";
const FAKE_GH = "opendots-gh.sh";
const FAKE_BG = "opendots-run-bg.sh";
const BG = "run-bg";
const fakeBins = (): void => {
  bin(GH, fakeScript(FAKE_GH));
  bin(BG, fakeScript(FAKE_BG));
};
const fakeTmux = (): void => bin("tmux", "exit 0\n");

const putIn = (where: string, name: string, data: string): void => writeFileSync(join(where, name), data);
const SEED = (): string => join(dir, "seed");
const ORIGIN = (): string => join(dir, "origin.git");
const seedStep = (args: string[]): string => run(SEED(), args);
const seedAdd = (): string => seedStep(["add", "base.txt"]);
const seedCommit = (): string => seedStep(["commit", "-q", "-m", "base"]);
const seedInit = (): string => seedStep(["init", "-q", "-b", "beta"]);
const seedPush = (): string => seedStep(["push", "-q", ORIGIN(), "beta"]);
const bareOrigin = (): string => run(dir, ["init", "-q", "--bare", "origin.git"]);
const cloneOrigin = (): string => run(dir, ["clone", "-q", ORIGIN(), workDir()]);
const seedFile = (): void => putIn(SEED(), "base.txt", "base\n");
const seedDir = (): void => makeDirs(SEED());
const seedRepo = (): void => [seedDir, seedInit, seedFile, seedAdd, seedCommit, bareOrigin, seedPush, cloneOrigin].forEach((f) => f());
const TMP = tmpdir();
const newDir = (): string => mkdtempSync(join(TMP, "team-continue-"));
const dir = newDir();
const fake = join(dir, "fake");
const runs = join(dir, "runs");
const wipe = (): void => rmSync(dir, { recursive: true, force: true });
const mkTree = (): void => makeDirs(join(fake, "bin"), runs, homeDir(), join(dir, "work"));
const mkRepos = (): void => putIn(dir, "repos", `${REPO}\n`);
beforeEach(() => [mkTree, fakeBins, fakeTmux, mkRepos, seedRepo].forEach((f) => f()));
afterEach(wipe);

const startedLine = (n: number, why: string): RegExp =>
  new RegExp(`^Started: owner/sandbox issue #${n}, claude run shift-builder-sandbox-${n}-\\d+ \\(${why}\\)\\.$`);
const LABEL_BUILDING = "agent:building";
const building = (n: number): Item => issue(n, [LABEL_BUILDING]);
const arrange = (how: string, log?: string): void => ended(5, how, log);
const builderTick = (): Out => tick("builder");
const scenario = (how: string, log?: string): Out => {
  [() => world([building(5)]), leaveWork, () => arrange(how, log)].forEach((f) => f());
  return builderTick();
};
const AT_CAP = "cap";
const EXIT0 = "exit0";
const EXIT1 = "exit1";
const branchNow = (): string => inWork(["symbolic-ref", "--short", "HEAD"]);
const BRANCH = "feat/big-thing";
const inTree = (name: string): string => text(join(workDir(), name));

it("cap: restarted on its branch, item not blocked", () => {
  const r = scenario(AT_CAP);
  expect(r.status).toBe(0);
  expect(item(ISSUE, 5).labels).toEqual([LABEL_BUILDING]);
  expect(started()).toBe(true);
  expect(branchNow()).toBe(BRANCH);
});
const treeKept = (): string => inTree("step1.txt") + inTree("wip.txt");
const KEPT = "committed\nuncommitted\n";

it("cap: the working tree is kept", () => {
  scenario(AT_CAP);
  expect(treeKept()).toBe(KEPT);
});
const tally5 = (): string => tally(5);
const ONE = "1";
const TWO = "2";

it("cap: the first continuation is recorded", () => {
  scenario(AT_CAP);
  expect(tally5()).toBe(ONE);
});
const FIVE = "5";
const jobFields = (): string[] => text(jobFile()).trim().split(" ");

it("cap: the job file keeps seven fields", () => {
  scenario(AT_CAP);
  expect(jobFields()).toHaveLength(7);
  expect(jobFields().slice(0, 3)).toEqual([REPO, ISSUE, FIVE]);
});
const WHY_CAP1 = "the last run was stopped at the 90-minute limit; continuing \\(1 of 2\\)";

it("cap: the restart is reported with its reason", () => {
  expect(scenario(AT_CAP).out).toMatch(startedLine(5, WHY_CAP1));
});
const JOB_NAME = /^shift-builder-sandbox-5-\d+$/;
const freshClock = (): boolean => Number(jobFields().at(4)) > Date.now() / 1000 - 30;
const ENGINE = "claude";

it("cap: the job clock restarts and the engine is kept", () => {
  scenario(AT_CAP);
  expect(jobFields().at(3)).toMatch(JOB_NAME);
  expect(freshClock()).toBe(true);
  expect(jobFields().at(5)).toBe(ENGINE);
});
const CONT_CAP1 = "CONTINUING (1 of 2): an earlier run on this item was stopped (at the 90-minute limit).";
const LOG_HINT = "git log origin/beta..HEAD";

it("cap: the run is told it is a continuation, with the branch", () => {
  scenario(AT_CAP);
  expect(prompt()).toContain(CONT_CAP1);
  expect(prompt()).toContain(`on branch ${BRANCH}`);
  expect(prompt()).toContain(LOG_HINT);
  expect(prompt()).toContain("Do not start over");
});

const COMMENT_CAP1 = /^Builder: the last run was stopped at the 90-minute limit; continuing \(1 of 2\)\. Started claude on this issue \(run shift-builder-sandbox-5-\d+\)\./;
it("cap: the founder sees the reason on the item", () => {
  scenario(AT_CAP);
  expect(item(ISSUE, 5).comments.at(0)).toMatch(COMMENT_CAP1);
});

const PREV_LINE = /^Shell commands you may run:/;
const NEXT_LINE = /^Follow-up issues \(FOLLOW-UPS above\):/;
const promptLines = (): string[] => prompt().split("\n");
const contAt = (): number => promptLines().findIndex((l) => l.startsWith("CONTINUING"));
const lineBefore = (): string => promptLines().slice(contAt() - 1, contAt()).join("");
const lineAfter = (): string => promptLines().slice(contAt() + 1, contAt() + 2).join("");

it("cap: the CONTINUING line sits between the shell-commands line and the follow-up line", () => {
  scenario(AT_CAP);
  expect(contAt()).toBeGreaterThan(0);
  expect(lineBefore()).toMatch(PREV_LINE);
  expect(lineAfter()).toMatch(NEXT_LINE);
});

const CHECK_DUE = "Due: owner/sandbox issue #5, run shift-builder-sandbox-5-1 is running.";
const checkTick = (): Out => tick("builder", ["--check"]);

it("cap: --check still prints Due so the cron wakes the shift, and starts nothing", () => {
  [() => world([building(5)]), leaveWork, () => arrange(AT_CAP)].forEach((f) => f());
  const r = checkTick();
  expect(r.out).toContain(CHECK_DUE);
  expect(started()).toBe(false);
  expect(existsSync(countFile(5))).toBe(false);
});

const WHY_EXIT0 = "the last run ended without handing the item over; continuing \\(1 of 2\\)";
const CONT_EXIT0 = "CONTINUING (1 of 2): an earlier run on this item was stopped (it ended without handing the item over).";

it("exit 0 without a hand-over: continued, tree kept, told why", () => {
  const r = scenario(EXIT0);
  expect(r.out).toMatch(startedLine(5, WHY_EXIT0));
  expect(item(ISSUE, 5).labels).toEqual([LABEL_BUILDING]);
  expect(tally5()).toBe(ONE);
  expect(treeKept()).toBe(KEPT);
  expect(prompt()).toContain(CONT_EXIT0);
});

const BLOCKED = "agent:blocked";
const stopAgain = (how: string): Out => {
  arrange(how);
  return builderTick();
};
const BLOCK_CAP2 = "Blocked: owner/sandbox issue #5. Builder: claude ran over 90 min and was stopped; it had already been continued 2 times. Last output:";
const BLOCK_EXIT0_2 = "Blocked: owner/sandbox issue #5. Builder: claude finished but did not hand the item over (label agent:building is still set); it had already been continued 2 times. Last output:";
const spend = (how: string): void => {
  scenario(how);
  stopAgain(how);
};
const goneAfterBlock = (): boolean => !existsSync(countFile(5)) && !existsSync(jobFile());

it("cap: the second restart is counted, the third stop blocks with the count in the text", () => {
  spend(AT_CAP);
  expect(tally5()).toBe(TWO);
  const r = stopAgain(AT_CAP);
  expect(r.out).toContain(BLOCK_CAP2);
  expect(item(ISSUE, 5).labels).toEqual([BLOCKED]);
});

it("cap: after the block the count and the job are gone and the tree is untouched", () => {
  spend(AT_CAP);
  stopAgain(AT_CAP);
  expect(goneAfterBlock()).toBe(true);
  expect(treeKept()).toBe(KEPT);
});

it("exit 0: the third stop blocks with the count in the text", () => {
  spend(EXIT0);
  const r = stopAgain(EXIT0);
  expect(r.out).toContain(BLOCK_EXIT0_2);
  expect(item(ISSUE, 5).labels).toEqual([BLOCKED]);
  expect(goneAfterBlock()).toBe(true);
});

const prepare = (how: string, log?: string): void => [() => world([building(5)]), leaveWork, () => arrange(how, log)].forEach((f) => f());
const tickMax = (max: string): Out => tick("builder", [], { TEAM_CONTINUE_MAX: max });
const BLOCK_CAP1 = "Blocked: owner/sandbox issue #5. Builder: claude ran over 90 min and was stopped; it had already been continued 1 time. Last output:";
const BLOCK_PLAIN = "Blocked: owner/sandbox issue #5. Builder: claude ran over 90 min and was stopped. Last output:";
const ZERO = "0";

it("TEAM_CONTINUE_MAX=1: one restart, then the block says 1 time", () => {
  prepare(AT_CAP);
  tickMax(ONE);
  expect(tally5()).toBe(ONE);
  arrange(AT_CAP);
  expect(tickMax(ONE).out).toContain(BLOCK_CAP1);
});

it("TEAM_CONTINUE_MAX=0: blocks at the cap as before, with no count in the text", () => {
  prepare(AT_CAP);
  const r = tickMax(ZERO);
  expect(r.out).toContain(BLOCK_PLAIN);
  expect(started()).toBe(false);
  expect(existsSync(countFile(5))).toBe(false);
});

const LABEL_IN_PR = "agent:in-pr";
const RESULT_LOG = "RESULT: PR opened\n";
const handedOver = (): Out => {
  world([issue(5, [LABEL_IN_PR])]);
  arrange(EXIT0, RESULT_LOG);
  return builderTick();
};

const DONE_LINE = "Done: owner/sandbox issue #5.";
const countThere = (): boolean => existsSync(countFile(5));

it("Done clears the count", () => {
  scenario(AT_CAP);
  expect(countThere()).toBe(true);
  expect(handedOver().out).toContain(DONE_LINE);
  expect(countThere()).toBe(false);
});

const CRASH_LINE = "Builder: claude stopped with exit=1. Last output:";

it("a crash after a restart still blocks, and clears the count", () => {
  scenario(AT_CAP);
  arrange(EXIT1);
  expect(builderTick().out).toContain(CRASH_LINE);
  expect(item(ISSUE, 5).labels).toEqual([BLOCKED]);
  expect(countThere()).toBe(false);
});

it("a crash on a first run blocks at once and counts nothing", () => {
  prepare(EXIT1);
  expect(builderTick().out).toContain(CRASH_LINE);
  expect(started()).toBe(false);
  expect(countThere()).toBe(false);
});

it("usage limit: agy takes over as before, nothing is counted, no CONTINUING line", () => {
  agyLogin();
  const r = scenario(EXIT0, LIMIT_LOG);
  expect(r.out).toMatch(AGY_STARTED);
  expect(countThere()).toBe(false);
  expect(noContinuing()).toBe(true);
});

it("usage limit after a restart: the count stays where it was", () => {
  scenario(AT_CAP);
  agyLogin();
  arrange(EXIT0, LIMIT_LOG);
  expect(builderTick().out).toMatch(AGY_STARTED);
  expect(tally5()).toBe(ONE);
  expect(noContinuing()).toBe(true);
});

const LIMIT_LOG = "Claude: you hit your weekly limit, it resets later\n";
const AGY_STARTED = /^Started: owner\/sandbox issue #5, agy run shift-builder-sandbox-5-\d+ \(claude hit its usage limit\)\.$/;
const noContinuing = (): boolean => !/CONTINUING \(\d/.test(prompt());

const AGY_DIR = (): string => join(homeDir(), ".gemini", "antigravity-cli");
const LOGIN_FILE = "antigravity-oauth-token";
const loginSteps = [() => makeDirs(AGY_DIR()), () => putIn(AGY_DIR(), LOGIN_FILE, "token")];
const agyLogin = (): void => loginSteps.forEach((f) => f());

const PLAIN_STARTED = /^Started: owner\/sandbox issue #5, claude run shift-builder-sandbox-5-\d+\.$/;
const wipGone = (): boolean => !existsSync(join(workDir(), "wip.txt"));
const onBranch = (): boolean => {
  try {
    return branchNow().length > 0;
  } catch {
    return false;
  }
};

const BUILDER = "builder";
const lostRun = (): Out => {
  [() => world([building(5)]), leaveWork, () => writeJob(BUILDER, ISSUE, 5, 600)].forEach((f) => f());
  return builderTick();
};

it("a lost run restarts as before, with no continuation", () => {
  expect(lostRun().out).toMatch(PLAIN_STARTED);
  expect(countThere()).toBe(false);
  expect(noContinuing()).toBe(true);
});

it("a lost run still gets the clean checkout", () => {
  lostRun();
  expect(wipGone()).toBe(true);
  expect(onBranch()).toBe(false);
});

const QUEUED = "agent:build";
const firstRun = (): Out => {
  [() => world([issue(5, [QUEUED])]), leaveWork].forEach((f) => f());
  return builderTick();
};
const headIs = (ref: string): string => inWork(["rev-parse", ref]);

const TIP = "HEAD";
const BASE_REF = "origin/beta";
const atBase = (): boolean => headIs(TIP) === headIs(BASE_REF);

it("a first run still starts with the clean checkout: leftovers gone, no branch, at the base", () => {
  expect(firstRun().out).toMatch(PLAIN_STARTED);
  expect(wipGone()).toBe(true);
  expect(onBranch()).toBe(false);
  expect(atBase()).toBe(true);
});

it("a first run is not told it is a continuation and counts nothing", () => {
  firstRun();
  expect(noContinuing()).toBe(true);
  expect(countThere()).toBe(false);
});

const NO_BRANCH_TEXT = "so this is a clean checkout of origin/beta";
const junkPath = (): string => join(workDir(), "junk.txt");

const DETACH_ARGS = ["checkout", "-q", "--detach"];
const JUNK = "left behind\n";
const detachSteps = [() => prepare(AT_CAP), () => inWork(DETACH_ARGS), () => putWork("junk.txt", JUNK)];
const leaveDetached = (): void => detachSteps.forEach((f) => f());

const ON_BRANCH = "on branch";
const junkGone = (): boolean => !existsSync(junkPath());

it("a continuation with no named branch gets the clean start", () => {
  leaveDetached();
  builderTick();
  expect(junkGone()).toBe(true);
  expect(tally5()).toBe(ONE);
});

it("a continuation with no named branch is told so and not given a branch", () => {
  leaveDetached();
  builderTick();
  expect(prompt()).toContain(NO_BRANCH_TEXT);
  expect(prompt().includes(ON_BRANCH)).toBe(false);
});

const moveSteps = [
  () => putIn(SEED(), "more.txt", "more\n"),
  () => seedStep(["add", "more.txt"]),
  () => seedStep(["commit", "-q", "-m", "more"]),
  seedPush,
];
const moveBase = (): void => moveSteps.forEach((f) => f());

const seedTip = (): string => seedStep(["rev-parse", TIP]);

it("a continuation still fetches: the moved base is visible, the branch and the tree stay", () => {
  prepare(AT_CAP);
  moveBase();
  builderTick();
  expect(headIs(BASE_REF)).toBe(seedTip());
  expect(branchNow()).toBe(BRANCH);
  expect(treeKept()).toBe(KEPT);
});

const NEXT_ITEM = 6;
const switchItem = (): void => {
  world([building(NEXT_ITEM)]);
  ended(NEXT_ITEM, AT_CAP);
};

it("the count is per item: a second item starts at 1, the first keeps its own", () => {
  scenario(AT_CAP);
  switchItem();
  builderTick();
  expect(tally(NEXT_ITEM)).toBe(ONE);
  expect(tally5()).toBe(ONE);
});
