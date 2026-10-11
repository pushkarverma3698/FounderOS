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



interface Item { repo: string; kind: "issue" | "pr"; number: number; labels: string[]; createdAt: string; comments: string[] }

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

function shift(role: string): { out: string; status: number | null; err: string } {
  const r = spawnSync("bash", [SCRIPT, role], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`,
      FAKE: fake,
      TEAM_RUNS: runs,
      TEAM_REPOS_FILE: join(dir, "repos"),
      TEAM_BRIEFS: BRIEFS,
    },
  });
  return { out: r.stdout.trim(), status: r.status, err: r.stderr };
}

function argv(): string[] {
  return readFileSync(join(fake, "argv"), "utf8").split("\0");
}

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
    const args = argv();
    expect(args[0]).toBe("claude");
    expect(args[1]).toBe("-p");
    expect(args[2]).toContain("YOUR ROLE: Architect");
    expect(args[2]).toContain("Repository: owner/sandbox. Item: issue #4");
    expect(args[2]).toContain("Base branch: beta.");
    expect(existsSync(join(runs, "shift-architect.job"))).toBe(true);
  });

  it("uses the default branch as base when the repo has no beta", () => {
    world([issue(4, ["agent:plan"])], { beta: false });
    shift("architect");
    expect(argv()[2]).toContain("Base branch: main.");
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
    writeFileSync(join(fake, "log"), "Claude usage limit reached\n");
    expect(shift("builder").out).toContain("claude stopped with exit=1");
    expect(item("issue", 5).labels).toEqual(["agent:blocked", "agent:in-pr"]);
    expect(item("issue", 5).comments[0]).toContain("Claude usage limit reached");
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
