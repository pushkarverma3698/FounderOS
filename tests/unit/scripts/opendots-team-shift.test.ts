/**
 * deploy/opendots/team-shift: one engineering shift in one shell call.
 * The OpenDots model (paid per token) only runs this and reports its output; claude does the work.
 * Audit 2026-10-11: with the Dot doing the work itself, 3 Dots spent ~$7.75 of OpenRouter credit in ~7 h
 * (Builder 358 and Reviewer 278 shell calls, each a new request re-sending the run).
 *
 * Runs against a fake gh (labels/comments in a JSON file) and a fake run-bg. No network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "deploy", "opendots", "team-shift");
const BRIEFS = join(ROOT, "deploy", "opendots", "team");
const REPO = "owner/sandbox";
const FAKES = join(ROOT, "tests", "unit", "scripts", "fakes");



interface Item { repo: string; kind: "issue" | "pr"; number: number; labels: string[]; createdAt: string; comments: string[]; title?: string; body?: string }

let dir: string;
let fake: string;
let runs: string;

function bin(name: string, body: string): void {
  const path = join(fake, "bin", name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const fakeScript = (file: string): string => readFileSync(join(FAKES, file), "utf8");

function world(items: Item[], opts: { beta?: boolean } = {}): void {
  writeFileSync(join(fake, "items.json"), JSON.stringify(items));
  if (opts.beta ?? true) writeFileSync(join(fake, "has-beta"), "");
}

function items(): Item[] {
  return JSON.parse(readFileSync(join(fake, "items.json"), "utf8")) as Item[];
}

function item(kind: string, n: number): Item {
  const found = items().find((i) => i.kind === kind && i.number === n);
  if (!found) throw new Error(`no ${kind} #${n}`);
  return found;
}

function shift(role: string, ...extra: string[]): { out: string; status: number | null; err: string } {
  const r = spawnSync("bash", [SCRIPT, role, ...extra], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`,
      FAKE: fake,
      TEAM_RUNS: runs,
      TEAM_REPOS_FILE: join(dir, "repos"),
      TEAM_BRIEFS: BRIEFS,
      TEAM_WORK: join(dir, "work"),
      HOME: join(dir, "home"),
    },
  });
  return { out: r.stdout.trim(), status: r.status, err: r.stderr };
}

function argv(): string[] {
  return readFileSync(join(fake, "argv"), "utf8").split("\0");
}
/** claude's own arguments: run-bg gets `sh -c 'cd "$0" && exec "$@"' <work dir> claude ...`. */
function claudeArgs(): string[] {
  const all = argv();
  return all.slice(all.indexOf("claude"));
}
const workDir = (): string => join(dir, "work", "sandbox");

/** Values given to a variadic claude flag, up to the next flag. */
function flagValues(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest.filter(Boolean) : rest.slice(0, end);
}

function writeJob(role: string, kind: string, n: number, startedSecondsAgo = 60): void {
  const started = Math.floor(Date.now() / 1000) - startedSecondsAgo;
  writeFileSync(join(runs, `shift-${role}.job`), `${REPO} ${kind} ${n} shift-${role}-sandbox-${n}-1 ${started}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "team-shift-"));
  fake = join(dir, "fake");
  runs = join(dir, "runs");
  spawnSync("mkdir", ["-p", join(fake, "bin"), runs]);
  bin("gh", fakeScript("opendots-gh.sh"));
  bin("run-bg", fakeScript("opendots-run-bg.sh"));
  bin("tmux", "#!/bin/sh\nexit 0\n");
  bin("git", `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE/git.log"\n[ -e "$FAKE/fetch-fails" ] && { echo "fatal: could not read from remote" >&2; exit 128; }\nexit 0\n`);
  writeFileSync(join(dir, "repos"), `# team repos\n${REPO}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const issue = (number: number, labels: string[], createdAt = "2026-10-10T10:00:00Z", comments: string[] = []): Item =>
  ({ repo: REPO, kind: "issue", number, labels, createdAt, comments });
const pr = (number: number, labels: string[], createdAt = "2026-10-10T10:00:00Z", comments: string[] = []): Item =>
  ({ repo: REPO, kind: "pr", number, labels, createdAt, comments });

describe("team-shift: nothing to do", () => {
  it('prints "No work" and starts nothing', () => {
    world([issue(1, ["agent:blocked"]), pr(2, ["agent:approved"])]);
    const r = shift("reviewer");
    expect(r).toMatchObject({ status: 0, out: "No work" });
    expect(existsSync(join(fake, "started"))).toBe(false);
  });

  it("rejects an unknown role", () => {
    world([]);
    expect(shift("chief").status).toBe(2);
  });
});

describe("team-shift: claiming work", () => {
  it("claims the oldest queued issue, starts claude on it with the brief, and comments", () => {
    world([issue(7, ["agent:plan"], "2026-10-10T12:00:00Z"), issue(4, ["agent:plan"], "2026-10-09T12:00:00Z")]);
    const r = shift("architect");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^Started: owner\/sandbox issue #4, claude run shift-architect-sandbox-4-\d+\.$/);
    expect(item("issue", 4).labels).toEqual(["agent:planning"]);
    expect(item("issue", 7).labels).toEqual(["agent:plan"]);
    expect(item("issue", 4).comments[0]).toMatch(/^Architect: started claude on this issue/);
    const args = claudeArgs();
    expect(args[0]).toBe("claude");
    expect(args[1]).toBe("-p");
    expect(args[2]).toContain("YOUR ROLE: Architect");
    expect(args[2]).toContain("Repository: owner/sandbox. Item: issue #4");
    expect(args[2]).toContain("Base branch: beta.");
    expect(existsSync(join(runs, "shift-architect.job"))).toBe(true);
  });

  it("clones the repo, fetches, and starts claude inside the clone (its permissions only cover its own directory)", () => {
    world([issue(4, ["agent:plan"])]);
    shift("architect");
    expect(existsSync(join(workDir(), ".git"))).toBe(true);
    expect(readFileSync(join(fake, "git.log"), "utf8")).toContain(`-C ${workDir()} fetch`);
    const all = argv();
    expect(all.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(all[3]).toBe(workDir());
    expect(all.slice(4, 6)).toEqual(["team-stream", "claude"]); // team-stream logs one line per step (AG-064)
    expect(claudeArgs()[2]).toContain(`Work directory: ${workDir()}`);
  });

  it("blocks the item and starts no claude when the repo cannot be fetched", () => {
    world([issue(4, ["agent:plan"])]);
    writeFileSync(join(fake, "fetch-fails"), "");
    const r = shift("architect");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^Blocked: owner\/sandbox issue #4\. Architect: could not prepare/);
    expect(item("issue", 4).labels).toEqual(["agent:blocked"]);
    expect(item("issue", 4).comments.join("\n")).toContain("could not read from remote");
    expect(existsSync(join(fake, "started"))).toBe(false);
    expect(existsSync(join(runs, "shift-architect.job"))).toBe(false);
  });

  it("uses the default branch as base when the repo has no beta", () => {
    world([issue(4, ["agent:plan"])], { beta: false });
    shift("architect");
    expect(claudeArgs()[2]).toContain("Base branch: main.");
  });

  it("gives the Builder a PR sent back with changes before a new issue", () => {
    world([issue(3, ["agent:build"], "2026-10-01T00:00:00Z"), pr(9, ["agent:changes"], "2026-10-10T00:00:00Z")]);
    expect(shift("builder").out).toContain("pr #9");
    expect(item("pr", 9).labels).toEqual(["agent:building"]);
    expect(item("issue", 3).labels).toEqual(["agent:build"]);
  });

  it("resumes an item already claimed for the role (its job was lost) without a second claim", () => {
    world([issue(3, ["agent:build"], "2026-10-01T00:00:00Z"), issue(8, ["agent:building"])]);
    expect(shift("builder").out).toContain("issue #8");
    expect(item("issue", 3).labels).toEqual(["agent:build"]);
  });
});

describe("team-shift: claude permissions", () => {
  function permissions(role: string, start: Item): { allowed: string[]; denied: string[]; all: string[] } {
    world([start]);
    shift(role);
    const all = argv();
    return { allowed: flagValues(all, "--allowedTools"), denied: flagValues(all, "--disallowedTools"), all };
  }

  it("never uses skip-permissions; merges, force-pushes, rebases and raw API calls are denied", () => {
    for (const [role, start] of [
      ["architect", issue(1, ["agent:plan"])],
      ["builder", issue(1, ["agent:build"])],
      ["reviewer", pr(1, ["agent:review"])],
    ] as const) {
      rmSync(join(runs, `shift-${role}.job`), { force: true });
      const p = permissions(role, start);
      expect(p.all.join(" ")).not.toContain("dangerously-skip-permissions");
      expect(p.denied).toEqual(expect.arrayContaining([
        "Bash(gh pr merge:*)", "Bash(gh api:*)", "Bash(git push --force:*)", "Bash(git rebase:*)",
      ]));
      expect(p.allowed.some((t) => t.includes("merge") && t.startsWith("Bash(gh"))).toBe(false);
    }
  });

  it("only the Builder may edit files, commit, push and open PRs", () => {
    const writes = ["Edit", "Write", "Bash(git commit:*)", "Bash(git push:*)", "Bash(gh pr create:*)"];
    expect(permissions("builder", issue(1, ["agent:build"])).allowed).toEqual(expect.arrayContaining(writes));
    for (const [role, start] of [["architect", issue(2, ["agent:plan"])], ["reviewer", pr(2, ["agent:review"])]] as const) {
      const allowed = permissions(role, start).allowed;
      for (const w of writes) expect(allowed).not.toContain(w);
    }
  });
});

describe("team-shift: an open job", () => {
  it("reports a running job without touching GitHub", () => {
    world([issue(4, ["agent:planning"])]);
    writeJob("architect", "issue", 4, 600);
    writeFileSync(join(fake, "state"), "running\n");
    const r = shift("architect");
    expect(r.out).toBe("Working: owner/sandbox issue #4, claude run shift-architect-sandbox-4-1, 10 min.");
    expect(existsSync(join(fake, "gh.log"))).toBe(false);
  });

  it("collects a finished job that handed the item over and prints its RESULT line", () => {
    world([issue(4, ["agent:build"])]);
    writeJob("architect", "issue", 4);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), "thinking...\nRESULT: plan posted, small, moved to agent:build\n");
    const r = shift("architect");
    expect(r.out).toBe("Done: owner/sandbox issue #4. RESULT: plan posted, small, moved to agent:build");
    expect(existsSync(join(runs, "shift-architect.job"))).toBe(false);
  });

  it("blocks an item claude finished without handing over", () => {
    world([issue(4, ["agent:planning"])]);
    writeJob("architect", "issue", 4);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), "I could not decide.\n");
    const r = shift("architect");
    expect(r.out).toMatch(/^Blocked: owner\/sandbox issue #4\. Architect: claude finished but did not hand the item over/);
    expect(item("issue", 4).labels).toEqual(["agent:blocked"]);
    expect(item("issue", 4).comments[0]).toContain("I could not decide.");
    expect(existsSync(join(runs, "shift-architect.job"))).toBe(false);
  });

  it("blocks the item when claude fails, keeping agent:in-pr", () => {
    world([issue(5, ["agent:building", "agent:in-pr"])]);
    writeJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), "Error: npm test failed\n");
    expect(shift("builder").out).toContain("claude stopped with exit=1");
    expect(item("issue", 5).labels).toEqual(["agent:blocked", "agent:in-pr"]);
    expect(item("issue", 5).comments[0]).toContain("npm test failed");
  });

  it("stops and blocks a run past the time limit", () => {
    world([pr(6, ["agent:reviewing"])]);
    writeJob("reviewer", "pr", 6, 91 * 60);
    writeFileSync(join(fake, "state"), "running\n");
    expect(shift("reviewer").out).toContain("claude ran over 90 min and was stopped");
    expect(item("pr", 6).labels).toEqual(["agent:blocked"]);
  });

  it("restarts a run the computer lost", () => {
    world([pr(6, ["agent:reviewing"])]);
    writeJob("reviewer", "pr", 6);
    expect(shift("reviewer").out).toMatch(/^Started: owner\/sandbox pr #6/);
    expect(item("pr", 6).labels).toEqual(["agent:reviewing"]);
  });
});

describe("team-shift: review rounds", () => {
  it("blocks a fourth review round for the founder instead of starting claude", () => {
    const verdicts = ["Reviewer verdict: CHANGES a", "Builder: fixed", "Reviewer verdict: CHANGES b", "Reviewer verdict: CHANGES c"];
    world([pr(5, ["agent:review"], undefined, verdicts)]);
    const r = shift("reviewer");
    expect(r.out).toContain("would be review round 4");
    expect(existsSync(join(fake, "started"))).toBe(false);
    expect(item("pr", 5).labels).toEqual(["agent:blocked"]);
  });

  it("still reviews a third round", () => {
    world([pr(5, ["agent:review"], undefined, ["Reviewer verdict: CHANGES a", "Reviewer verdict: CHANGES b"])]);
    expect(shift("reviewer").out).toMatch(/^Started: owner\/sandbox pr #5/);
  });
});

/**
 * deploy/opendots/setup-dots.sh against a fake owner API (curl), docker and crontab.
 * Founder 2026-10-11: an idle shift costs nothing, so shifts are checked every 15 min. A host cron (shift-cron) is the only
 * clock; the OpenDots shift tasks have no interval of their own, so the paid Dot runs only when cron wakes it.
 * A rerun must fix existing tasks too (it used to set the interval only when it created a task).
 */
describe("setup-dots.sh: shift schedule", () => {
  const SETUP = join(ROOT, "deploy", "opendots", "setup-dots.sh");
  const TOKEN = "owner-token-not-for-output";
  const shiftPrompt = (role: string): string => `${role} shift: follow your SHIFT rules for one item, or reply "No work".`;
  const shiftTasks = (every: number | null) => ["Architect", "Builder", "Reviewer"].map((role) =>
    ({ id: `t-${role}`, prompt: shiftPrompt(role), status: "completed", intervalSeconds: every }));

  function setup(tasks: { id: string; prompt: string; status: string; intervalSeconds: number | null }[], env: Record<string, string> = {}) {
    spawnSync("mkdir", ["-p", join(dir, "app")]);
    writeFileSync(join(dir, "app", ".env"), `X=1\nOWNER_TOKEN=${TOKEN}\n`);
    bin("curl", fakeScript("opendots-curl.sh"));
    bin("docker", fakeScript("opendots-docker.sh"));
    bin("crontab", fakeScript("opendots-crontab.sh"));
    const dots = [["Chief of Staff", "chief"], ["Builder", "b"], ["Architect", "a"], ["Reviewer", "r"]];
    writeFileSync(join(fake, "workspace.json"), JSON.stringify({
      spaces: [{ name: "Everyday", id: "s1" }],
      dots: dots.map(([name, id]) => ({ name, id })),
      conversations: ["a", "b", "r"].map((d) => ({ dotId: d, title: "Shift", id: `c-${d}` })),
    }));
    writeFileSync(join(fake, "state.json"), JSON.stringify({ tasks }));
    const r = spawnSync("bash", [SETUP], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: fake,
        FAKE_OWNER_TOKEN: TOKEN, OPENDOTS_APP: join(dir, "app"), OPENDOTS_SHIFT_TASKS: join(dir, "shift-tasks"), ...env },
    });
    const calls = existsSync(join(fake, "curl.log")) ? readFileSync(join(fake, "curl.log"), "utf8").trim().split("\n") : [];
    return { status: r.status, out: r.stdout + r.stderr, calls };
  }
  const crontab = (): string => readFileSync(join(fake, "crontab"), "utf8");

  it("takes the interval off existing shift tasks and never prints the owner token", () => {
    const r = setup(shiftTasks(900));
    expect(r.status, r.out).toBe(0);
    for (const role of ["Architect", "Builder", "Reviewer"])
      expect(r.calls).toContain(`PUT /tasks/t-${role}/schedule {"intervalSeconds":null}`);
    expect(r.calls.some((c) => c.startsWith("POST /tasks "))).toBe(false);
    expect(r.out).not.toContain(TOKEN);
  });

  it("creates a missing shift task without an interval, paused", () => {
    const r = setup([]);
    expect(r.status, r.out).toBe(0);
    const created = r.calls.filter((c) => c.startsWith("POST /tasks "));
    expect(created).toHaveLength(3);
    for (const c of created) expect(c).not.toContain("intervalSeconds");
    expect(r.calls).toContain('POST /tasks/new-tasks/actions {"action":"pause"}');
  });

  it("leaves a task without an interval alone", () => {
    const r = setup(shiftTasks(null));
    expect(r.status, r.out).toBe(0);
    expect(r.calls.some((c) => c.includes("/schedule"))).toBe(false);
  });

  it("writes role, Dot and task for shift-cron, and installs one 15-minute cron line, keeping other lines", () => {
    writeFileSync(join(fake, "crontab"), "*/2 * * * * other-job\n0 * * * * old # opendots-shift\n");
    const r = setup(shiftTasks(null));
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(dir, "shift-tasks"), "utf8")).toBe("architect a t-Architect\nbuilder b t-Builder\nreviewer r t-Reviewer\n");
    const lines = crontab().trim().split("\n");
    expect(lines[0]).toBe("*/2 * * * * other-job");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^\*\/15 \* \* \* \* .*\/shift-cron >> .*shift-cron\.log 2>&1 # opendots-shift$/);
  });

  // AG-063: the Chief dispatches to claude through chief-run, so it gets the Builder's claude and agy logins and the
  // team repos, and its prompt (max 2000 characters, the app's zod limit) is one command per request.
  it("gives the Chief a chief-run prompt within 2000 characters, the Builder's claude and agy logins, and the team repos", () => {
    const r = setup(shiftTasks(null));
    expect(r.status, r.out).toBe(0);
    const put = r.calls.find((c) => c.startsWith("PUT /dots/chief "));
    const prompt = (JSON.parse(put?.slice("PUT /dots/chief ".length) ?? "{}") as { instructions: string }).instructions;
    expect([...prompt].length).toBeLessThanOrEqual(2000);
    expect(prompt).toContain("chief-run");
    expect(prompt).toContain("dot-login");
    expect(prompt).toContain("still running");
    // The computer tool's description says to snapshot first; for the Chief that is a wasted paid model call.
    expect(prompt).toContain("no computer_snapshot");
    // chief-run waits up to 55 s (CHIEF_WAIT); a shorter shell timeout would cut it and lose its output.
    expect(prompt).toContain("timeoutMs 60000");
    const docker = readFileSync(join(fake, "docker.log"), "utf8").trim().split("\n");
    // Both ends of one copy pipe log in either order, but copies run one after another: the k-th tar -xf reads the
    // k-th tar -cf.
    const packs = docker.filter((l) => l.includes(" tar -cf "));
    const unpacks = docker.filter((l) => l.includes(" tar -xf "));
    const k = unpacks.findIndex((l) => l.startsWith("exec -i -w /workspace opendots-computer-chief tar -xf"));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(packs[k]).toContain(".claude-token");
    expect(packs[k]).toContain(".gemini/antigravity-cli/antigravity-oauth-token");
    expect(unpacks[k]).toContain("--skip-old-files");
    expect(docker).toContain("exec -i opendots-computer-chief sh -c cat > /workspace/team-repos");
    // The app reports a disabled browser as "Computer permission is disabled"; the Chief read that as "no computer"
    // and gave up (founder chats 2026-10-11), so it gets the same permissions as the engineers.
    expect(r.calls).toContain('PATCH /dots/chief/computer/permissions {"enabled":true,"browser":true,"files":true,"shell":true}');
  });

  // AG-064: the Builder takes direct tasks, answers "what's happening", and checks claude/agy itself.
  it("gives the Builder the task, progress and login commands within 2000 characters", () => {
    const r = setup(shiftTasks(null));
    expect(r.status, r.out).toBe(0);
    const put = r.calls.find((c) => c.startsWith("PUT /dots/b "));
    const prompt = (JSON.parse(put?.slice("PUT /dots/b ".length) ?? "{}") as { instructions: string }).instructions;
    expect([...prompt].length).toBeLessThanOrEqual(2000);
    for (const s of ["team-shift builder --engine", "--task", "team-shift builder --progress", "dot-login status"])
      expect(prompt).toContain(s);
    expect(prompt).toMatch(/never say the Chief/i);
  });

  it("SHIFT_SECONDS=3600 gives an hourly cron; a value cron cannot express is refused", () => {
    expect(setup(shiftTasks(null), { SHIFT_SECONDS: "3600" }).status).toBe(0);
    expect(crontab()).toMatch(/^0 \* \* \* \* /);
    const bad = setup(shiftTasks(null), { SHIFT_SECONDS: "2700" });
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("SHIFT_SECONDS");
  });
});

/**
 * Free idle shifts (founder 2026-10-11): a host cron runs `team-shift <role> --check` in each computer and wakes the
 * Dot (a paid OpenRouter call) only when the check finds something to claim or collect. The check changes nothing.
 */
describe("team-shift --check: read-only", () => {
  function check(role: string): { out: string; status: number | null } {
    const r = spawnSync("bash", [SCRIPT, role, "--check"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: fake, TEAM_RUNS: runs,
        TEAM_REPOS_FILE: join(dir, "repos"), TEAM_BRIEFS: BRIEFS, TEAM_WORK: join(dir, "work") },
    });
    return { out: r.stdout.trim(), status: r.status };
  }
  const writes = (): string[] => (existsSync(join(fake, "gh.log")) ? readFileSync(join(fake, "gh.log"), "utf8") : "")
    .split("\n").filter((l) => /^(issue|pr) (edit|comment)|^label create|^repo clone/.test(l));

  it('prints "No work" when no queue has an item', () => {
    world([issue(1, ["agent:blocked"])]);
    expect(check("architect")).toEqual({ out: "No work", status: 0 });
  });

  it("reports a queued item as Due without claiming, cloning, commenting or starting claude", () => {
    world([issue(4, ["agent:plan"])]);
    expect(check("architect")).toEqual({ out: "Due: owner/sandbox issue #4 (agent:plan)", status: 0 });
    expect(item("issue", 4)).toMatchObject({ labels: ["agent:plan"], comments: [] });
    expect(writes()).toEqual([]);
    expect(existsSync(join(fake, "started"))).toBe(false);
    expect(existsSync(join(runs, "shift-architect.job"))).toBe(false);
  });

  it("reports an item claimed for the role (its job was lost) as Due", () => {
    world([issue(8, ["agent:building"])]);
    expect(check("builder").out).toBe("Due: owner/sandbox issue #8 (agent:building)");
  });

  it("a run still inside its limit is Working, not Due", () => {
    world([issue(4, ["agent:planning"])]);
    writeJob("architect", "issue", 4, 600);
    writeFileSync(join(fake, "state"), "running\n");
    expect(check("architect").out).toBe("Working: owner/sandbox issue #4, claude run shift-architect-sandbox-4-1, 10 min.");
  });

  it("a finished, failed, lost or overdue run is Due and the job file stays for the real shift", () => {
    for (const [state, age] of [["exit=0", 60], ["exit=1", 60], ["unknown", 60], ["running", 91 * 60]] as const) {
      world([issue(4, ["agent:planning"])]);
      writeJob("architect", "issue", 4, age);
      writeFileSync(join(fake, "state"), `${state}\n`);
      expect(check("architect").out).toBe(`Due: owner/sandbox issue #4, run shift-architect-sandbox-4-1 is ${state}.`);
      expect(existsSync(join(runs, "shift-architect.job"))).toBe(true);
    }
    expect(writes()).toEqual([]);
    expect(item("issue", 4).labels).toEqual(["agent:planning"]);
  });
});

/** deploy/opendots/shift-cron: the host side. Wakes a Dot's shift task only on Due or a failed check. */
describe("shift-cron: wakes a Dot only when there is work", () => {
  const CRON = join(ROOT, "deploy", "opendots", "shift-cron");
  const TOKEN = "owner-token-not-for-output";

  function cron(checks: Record<string, { out: string; rc?: number }>, statuses: Record<string, string> = {}) {
    spawnSync("mkdir", ["-p", join(dir, "app")]);
    writeFileSync(join(dir, "app", ".env"), `OWNER_TOKEN=${TOKEN}\n`);
    writeFileSync(join(dir, "shift-tasks"), "architect dot-a task-a\nbuilder dot-b task-b\nreviewer dot-r task-r\n");
    for (const [role, c] of Object.entries(checks)) {
      writeFileSync(join(fake, `check-${role}`), `${c.out}\n`);
      if (c.rc) writeFileSync(join(fake, `check-${role}.rc`), String(c.rc));
    }
    for (const [task, status] of Object.entries(statuses)) writeFileSync(join(fake, `task-${task}`), status);
    bin("curl", fakeScript("opendots-curl.sh"));
    bin("docker", fakeScript("opendots-docker.sh"));
    bin("timeout", '#!/bin/sh\nshift\nexec "$@"\n'); // macOS has no timeout(1); the VPS does
    const r = spawnSync("bash", [CRON], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: fake,
        FAKE_OWNER_TOKEN: TOKEN, OPENDOTS_APP: join(dir, "app"), OPENDOTS_SHIFT_TASKS: join(dir, "shift-tasks") },
    });
    const calls = existsSync(join(fake, "curl.log")) ? readFileSync(join(fake, "curl.log"), "utf8").trim().split("\n") : [];
    const runs = calls.filter((c) => c.includes('{"action":"run"}'));
    return { status: r.status, out: r.stdout + r.stderr, calls, runs };
  }

  it("idle everywhere: no task is woken and the OpenDots app is not called", () => {
    const r = cron({ architect: { out: "No work" }, builder: { out: "No work" }, reviewer: { out: "Working: x" } });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
    expect(readFileSync(join(fake, "docker.log"), "utf8")).toContain("exec opendots-computer-dot-a team-shift architect --check");
  });

  it("wakes only the role with work", () => {
    const r = cron({ architect: { out: "Due: owner/sandbox issue #4 (agent:plan)" }, builder: { out: "No work" }, reviewer: { out: "No work" } });
    expect(r.runs).toEqual(['POST /tasks/task-a/actions {"action":"run"}']);
    expect(r.out).toContain("architect: Due: owner/sandbox issue #4 (agent:plan) -> woke task-a");
    expect(r.out).not.toContain(TOKEN);
  });

  it("a failing check wakes the Dot so the error reaches the founder", () => {
    const r = cron({ architect: { out: "gh: authentication required", rc: 1 }, builder: { out: "No work" }, reviewer: { out: "No work" } });
    expect(r.runs).toEqual(['POST /tasks/task-a/actions {"action":"run"}']);
  });

  it("never wakes a paused, cancelled, queued or running task (pausing stays the kill switch)", () => {
    const due = { out: "Due: x" };
    const r = cron({ architect: due, builder: due, reviewer: due }, { "task-a": "paused", "task-b": "running", "task-r": "cancelled" });
    expect(r.runs).toEqual([]);
    expect(r.out).toContain("architect: Due: x -> task-a is paused, not woken");
  });
});

/**
 * agy fallback (founder 2026-10-11): when claude hits its usage limit, the Builder and Reviewer hand the same item and
 * brief to agy instead of blocking. agy gets the role's allowlist as settings.json allow/deny rules (no
 * skip-permissions). The Architect has no agy login and still blocks.
 */
describe("team-shift: agy fallback on a claude usage limit", () => {
  const home = (): string => join(dir, "home");
  const settingsPath = (): string => join(home(), ".gemini", "antigravity-cli", "settings.json");
  function agyLogin(): void {
    spawnSync("mkdir", ["-p", join(home(), ".gemini", "antigravity-cli")]);
    writeFileSync(join(home(), ".gemini", "antigravity-cli", "antigravity-oauth-token"), "x");
  }
  const LIMIT = "Working on it...\nYou've hit your weekly limit · resets Oct 12, 6am (UTC)\n";
  const agyArgs = (): string[] => { const all = argv(); return all.slice(all.indexOf("agy")); };
  const settings = () => JSON.parse(readFileSync(settingsPath(), "utf8")) as
    { colorScheme?: string; permissions: { allow: string[]; deny: string[] } };

  it("starts agy on the same item with the same brief when claude stopped on its limit", () => {
    agyLogin();
    world([issue(5, ["agent:building", "agent:in-pr"])]);
    writeJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), LIMIT);
    const r = shift("builder");
    expect(r.out).toMatch(/^Started: owner\/sandbox issue #5, agy run shift-builder-sandbox-5-\d+ \(claude hit its usage limit\)\.$/);
    expect(item("issue", 5).labels).toEqual(["agent:building", "agent:in-pr"]);
    expect(item("issue", 5).comments[0]).toMatch(/^Builder: claude hit its usage limit, so agy took over/);
    const args = agyArgs();
    expect(args.slice(0, 2)).toEqual(["agy", "--new-project"]);
    expect(args[args.indexOf("--print") + 1]).toContain("YOUR ROLE: Builder");
    expect(args[args.indexOf("--print") + 1]).toContain("Item: issue #5");
    expect(args.join(" ")).not.toContain("dangerously-skip-permissions");
    expect(argv()[3]).toBe(workDir());
    expect(readFileSync(join(runs, "shift-builder.job"), "utf8")).toMatch(/ agy\n$/);
  });

  it("also takes over when claude exited 0 on its weekly limit without handing the item over", () => {
    agyLogin();
    world([pr(6, ["agent:reviewing"])]);
    writeJob("reviewer", "pr", 6);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), LIMIT);
    expect(shift("reviewer").out).toMatch(/^Started: owner\/sandbox pr #6, agy run /);
    expect(item("pr", 6).labels).toEqual(["agent:reviewing"]);
  });

  it("gives agy the role's allowlist as settings rules and keeps the file's other settings", () => {
    agyLogin();
    writeFileSync(settingsPath(), JSON.stringify({ colorScheme: "light", permissions: { allow: ["command(rm -rf /)"] } }));
    world([pr(6, ["agent:reviewing"])]);
    writeJob("reviewer", "pr", 6);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), LIMIT);
    shift("reviewer");
    const s = settings();
    expect(s.colorScheme).toBe("light");
    expect(s.permissions.allow).toEqual(expect.arrayContaining(["read_file(*)", "command(gh pr view)", "command(gh pr ready)"]));
    expect(s.permissions.allow).not.toContain("command(rm -rf /)");
    expect(s.permissions.allow).not.toContain("write_file(*)");
    expect(s.permissions.allow).not.toContain("command(git push)");
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["command(gh pr merge)", "command(gh api)", "command(git push --force)"]));
  });

  it("the Builder's agy may write files and push", () => {
    agyLogin();
    world([issue(5, ["agent:building"])]);
    writeJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), LIMIT);
    shift("builder");
    expect(settings().permissions.allow).toEqual(expect.arrayContaining(["write_file(*)", "command(git push)", "command(gh pr create)"]));
  });

  it("the Architect has no agy, so a limit still blocks for the founder", () => {
    agyLogin();
    world([issue(4, ["agent:planning"])]);
    writeJob("architect", "issue", 4);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), LIMIT);
    expect(shift("architect").out).toMatch(/^Blocked: owner\/sandbox issue #4\. Architect: claude stopped with exit=1/);
    expect(existsSync(join(fake, "started"))).toBe(false);
  });

  it("blocks when the computer has no agy login", () => {
    world([issue(5, ["agent:building"])]);
    writeJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), LIMIT);
    const r = shift("builder");
    expect(r.out).toMatch(/^Blocked: owner\/sandbox issue #5\./);
    expect(item("issue", 5).comments[0]).toContain("no agy login");
    expect(existsSync(join(fake, "started"))).toBe(false);
  });

  function writeAgyJob(role: string, kind: string, n: number): void {
    const started = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(join(runs, `shift-${role}.job`), `${REPO} ${kind} ${n} shift-${role}-sandbox-${n}-2 ${started} agy\n`);
  }

  it("collects an agy run that handed the item over even when agy exited non-zero (#452)", () => {
    world([issue(5, ["agent:in-pr"])]);
    writeAgyJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), "RESULT: PR #9 opened\n");
    expect(shift("builder").out).toBe("Done: owner/sandbox issue #5. RESULT: PR #9 opened");
  });

  it("blocks an agy run that did not hand over and never falls back again", () => {
    agyLogin();
    world([issue(5, ["agent:building"])]);
    writeAgyJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), "Individual quota reached. Resets in 3h\n");
    const r = shift("builder");
    expect(r.out).toMatch(/^Blocked: owner\/sandbox issue #5\. Builder: agy stopped with exit=1/);
    expect(existsSync(join(fake, "started"))).toBe(false);
  });

  it("reports a running agy run as agy", () => {
    world([issue(5, ["agent:building"])]);
    writeAgyJob("builder", "issue", 5);
    writeFileSync(join(fake, "state"), "running\n");
    expect(shift("builder").out).toBe("Working: owner/sandbox issue #5, agy run shift-builder-sandbox-5-2, 1 min.");
  });
});

/**
 * AG-064 (founder 2026-10-11): "I want to assign more tasks to the builder directly, and it calls agy or claude,
 * whichever I tell it to ... Will the builder give complete reasoning at the end and show what is happening in
 * between?" A direct task is filed as an issue (labels and audit trail keep working) and starts the named engine.
 */
describe("team-shift builder --task: a direct task from the founder's chat", () => {
  const TASK = "Add a CONTRIBUTING.md that says: run npm test before every PR";
  function agyLogin(): void {
    spawnSync("mkdir", ["-p", join(dir, "home", ".gemini", "antigravity-cli")]);
    writeFileSync(join(dir, "home", ".gemini", "antigravity-cli", "antigravity-oauth-token"), "x");
  }

  it("files the task as a claimed issue and starts claude on it, with the issue body as the plan", () => {
    world([issue(3, ["agent:build"])]);
    const r = shift("builder", "--engine", "claude", "--task", TASK);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^Started: owner\/sandbox issue #4, claude run shift-builder-sandbox-4-\d+\.$/);
    const filed = item("issue", 4);
    expect(filed.labels).toEqual(["agent:building"]);
    expect(filed.body).toContain(TASK);
    expect(filed.title).toBe(TASK);
    expect(item("issue", 3).labels).toEqual(["agent:build"]); // the queue is untouched
    const args = claudeArgs();
    expect(args[2]).toContain("Item: issue #4");
    expect(args[2]).toContain("the issue body is the plan");
    expect(argv().join(" ")).not.toContain("dangerously-skip-permissions");
  });

  it("starts agy when the founder names agy, with the Builder's rules", () => {
    agyLogin();
    world([]);
    const r = shift("builder", "--engine", "agy", "--repo", "sandbox", "--task", TASK);
    expect(r.out).toMatch(/^Started: owner\/sandbox issue #1, agy run /);
    const all = argv();
    expect(all.slice(all.indexOf("agy"), all.indexOf("agy") + 2)).toEqual(["agy", "--new-project"]);
    expect(readFileSync(join(runs, "shift-builder.job"), "utf8")).toMatch(/ agy\n$/);
  });

  it("refuses agy without an agy login, before filing anything", () => {
    world([]);
    const r = shift("builder", "--engine", "agy", "--task", TASK);
    expect(r.out).toContain("no agy login");
    expect(r.out).toContain("dot-login agy start");
    expect(items()).toEqual([]);
    expect(existsSync(join(fake, "started"))).toBe(false);
  });

  it("refuses a repo outside the team and names the team repos", () => {
    world([]);
    const r = shift("builder", "--engine", "claude", "--repo", "someone/else", "--task", TASK);
    expect(r.out).toBe("Not a team repo: someone/else. Team repos: owner/sandbox.");
    expect(items()).toEqual([]);
  });

  it("refuses while a Builder run is open, and files nothing", () => {
    world([issue(5, ["agent:building"])]);
    writeJob("builder", "issue", 5, 120);
    writeFileSync(join(fake, "state"), "running\n");
    const r = shift("builder", "--engine", "claude", "--task", TASK);
    expect(r.out).toBe("Busy: owner/sandbox issue #5, claude run shift-builder-sandbox-5-1, 2 min. Ask again when it is done.");
    expect(items()).toHaveLength(1);
  });

  it("closes a finished run first (its Done block), then files and starts the task", () => {
    world([issue(5, ["agent:in-pr"])]);
    writeJob("builder", "issue", 5, 600);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), "WHAT I DID: added /health\nWHY: issue #5\nWHAT'S LEFT: review\nRESULT: PR #7\n");
    const r = shift("builder", "--engine", "claude", "--task", TASK);
    expect(r.status, r.err).toBe(0);
    const lines = r.out.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "Done: owner/sandbox issue #5.", "WHAT I DID: added /health", "WHY: issue #5", "WHAT'S LEFT: review", "RESULT: PR #7",
    ]);
    expect(lines[5]).toMatch(/^Started: owner\/sandbox issue #6, claude run shift-builder-sandbox-6-\d+\.$/);
    expect(item("issue", 6).labels).toEqual(["agent:building"]);
  });

  it("rejects an unknown engine, an empty task, and a task for another role", () => {
    world([]);
    expect(shift("builder", "--engine", "gpt", "--task", TASK).status).toBe(2);
    expect(shift("builder", "--engine", "claude", "--task", "  ").status).toBe(2);
    expect(shift("reviewer", "--engine", "claude", "--task", TASK).status).toBe(2);
    expect(items()).toEqual([]);
  });

  it("reports a failed issue create and starts nothing", () => {
    world([]);
    writeFileSync(join(fake, "create-fails"), "");
    const r = shift("builder", "--engine", "claude", "--task", TASK);
    expect(r.out).toMatch(/^Could not file the task on owner\/sandbox: could not add label/);
    expect(existsSync(join(fake, "started"))).toBe(false);
  });
});

describe("team-shift: progress in between and reasoning at the end", () => {
  it("claude streams its steps (stream-json through a readable filter), still without skip-permissions", () => {
    world([issue(1, ["agent:build"])]);
    shift("builder");
    const args = claudeArgs();
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(argv().join(" ")).not.toContain("dangerously-skip-permissions");
  });

  it("the stream filter turns claude's events into one readable line each and keeps unknown lines", () => {
    const filter = join(ROOT, "deploy", "opendots", "team-stream");
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading the README first." }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/w/README.md" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "WHAT I DID: x\nRESULT: PR #9" }] } },
      { type: "result", subtype: "success", is_error: false, result: "WHAT I DID: x\nRESULT: PR #9" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json at all\n";
    const r = spawnSync("bash", [filter], { input: events, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("Reading the README first.\n> Bash: npm test\n> Edit: /w/README.md\nWHAT I DID: x\nRESULT: PR #9\nnot json at all\n");
  });

  it("the stream filter prints an error result (the usage-limit text) so the limit check still sees it", () => {
    const filter = join(ROOT, "deploy", "opendots", "team-stream");
    const ev = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit" });
    expect(spawnSync("bash", [filter], { input: `${ev}\n`, encoding: "utf8" }).stdout).toBe("You've hit your weekly limit\n");
  });

  it("--progress prints at most 5 short lines and changes nothing", () => {
    world([issue(5, ["agent:building"])]);
    writeJob("builder", "issue", 5, 180);
    writeFileSync(join(fake, "state"), "running\n");
    writeFileSync(join(fake, "log"), ["a", "b", "", "> Bash: npm test", "x".repeat(300), "Writing the fix now."].join("\n") + "\n");
    const r = shift("builder", "--progress");
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("Builder: claude on owner/sandbox issue #5, 3 min, running. Last steps:");
    expect(lines.slice(1)).toEqual(["b", "> Bash: npm test", `${"x".repeat(159)}…`, "Writing the fix now."]);
    expect(existsSync(join(fake, "gh.log"))).toBe(false);
    expect(existsSync(join(runs, "shift-builder.job"))).toBe(true);
  });

  it("--progress with no run says so", () => {
    world([]);
    expect(shift("builder", "--progress").out).toBe("Builder: no run open.");
  });

  it("Done prints the run's reasoning block (the last one), not just RESULT", () => {
    world([issue(4, ["agent:in-pr"])]);
    writeJob("builder", "issue", 4);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), [
      "> Bash: npm test", "WHAT I DID: draft", "RESULT: draft",
      "WHAT I DID: added CONTRIBUTING.md, opened PR #9", "WHY: issue #4 asked for it",
      "WHAT'S LEFT: Reviewer pass", "RESULT: https://github.com/owner/sandbox/pull/9", "",
    ].join("\n"));
    expect(shift("builder").out).toBe([
      "Done: owner/sandbox issue #4.", "WHAT I DID: added CONTRIBUTING.md, opened PR #9", "WHY: issue #4 asked for it",
      "WHAT'S LEFT: Reviewer pass", "RESULT: https://github.com/owner/sandbox/pull/9",
    ].join("\n"));
  });

  it("every run's brief asks for the four-line ending", () => {
    const team = readFileSync(join(BRIEFS, "team.md"), "utf8");
    for (const l of ["WHAT I DID:", "WHY:", "WHAT'S LEFT:", "RESULT:"]) expect(team).toContain(l);
  });
});
