/**
 * deploy/opendots/chief-run (AG-063): the Chief of Staff Dot runs one command per chat turn; claude (haiku) does the
 * gh work, agy takes over on a claude usage limit, and the script checks every claimed action against GitHub itself.
 * Merges are done by the script, only for a PR the founder named that has agent:approved.
 *
 * Runs against a fake gh (issues/PRs in a JSON file) and a fake run-bg. No network, no model.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "deploy", "opendots", "chief-run");
const BRIEFS = join(ROOT, "deploy", "opendots", "team");
const FAKES = join(ROOT, "tests", "unit", "scripts", "fakes");
const REPO = "owner/sandbox";

interface Item {
  head?: string;
  base?: string;
  repo: string; number: number; kind: "issue" | "pr"; state: string; labels: string[];
  created_at: string; comments: { created_at: string }[]; closes?: number[];
}

let dir: string;
let fake: string;
let runs: string;

function bin(name: string, body: string): void {
  const path = join(fake, "bin", name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const fakeScript = (file: string): string => readFileSync(join(FAKES, file), "utf8");
const world = (items: Item[]): void => writeFileSync(join(fake, "items.json"), JSON.stringify(items));
const find = (n: number): Item => {
  const it = (JSON.parse(readFileSync(join(fake, "items.json"), "utf8")) as Item[]).find((i) => i.number === n);
  if (!it) throw new Error(`no #${n}`);
  return it;
};
const NEW = "2099-01-01T00:00:00Z";
const OLD = "2020-01-01T00:00:00Z";
const issue = (number: number, labels: string[], o: Partial<Item> = {}): Item =>
  ({ repo: REPO, number, kind: "issue", state: "OPEN", labels, created_at: NEW, comments: [], ...o });
const pr = (number: number, labels: string[], o: Partial<Item> = {}): Item =>
  ({ repo: REPO, number, kind: "pr", state: "OPEN", labels, created_at: OLD, comments: [], ...o });

/** A finished claude run that printed `log`. */
function claudeDone(log: string, state = "exit=0"): void {
  writeFileSync(join(fake, "state"), `${state}\n`);
  writeFileSync(join(fake, "log"), log);
}
function agyLogin(): void {
  mkdirSync(join(dir, "home", ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(dir, "home", ".gemini", "antigravity-cli", "antigravity-oauth-token"), "x");
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`,
    FAKE: fake,
    TEAM_RUNS: runs,
    TEAM_REPOS_FILE: join(dir, "repos"),
    TEAM_BRIEFS: BRIEFS,
    CHIEF_DIR: join(dir, "chief"),
    CHIEF_WAIT: "0",
    HOME: join(dir, "home"),
    ...extra,
  };
}
function chief(args: string[], extra: Record<string, string> = {}): { out: string; status: number | null } {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: env(extra) });
  return { out: (r.stdout + r.stderr).trim(), status: r.status };
}

const argv = (file = "argv"): string[] => readFileSync(join(fake, file), "utf8").split("\0");
function claudeArgs(): string[] {
  const all = argv();
  return all.slice(all.indexOf("claude"));
}
function flagValues(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest.filter(Boolean) : rest.slice(0, end);
}
const ghLog = (): string => (existsSync(join(fake, "gh.log")) ? readFileSync(join(fake, "gh.log"), "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-run-"));
  fake = join(dir, "fake");
  runs = join(dir, "runs");
  mkdirSync(join(fake, "bin"), { recursive: true });
  mkdirSync(runs);
  bin("gh", fakeScript("opendots-chief-gh.sh"));
  bin("run-bg", fakeScript("opendots-chief-run-bg.sh"));
  writeFileSync(join(dir, "repos"), `# team repos\n${REPO}\n`);
  world([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("chief-run: starting claude", () => {
  it("runs claude -p on haiku with the chief brief and the founder's exact words", () => {
    claudeDone("2 items open.\n");
    const r = chief(["status please"]);
    expect(r.status).toBe(0);
    const args = claudeArgs();
    expect(args.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(args[2]).toContain("YOUR ROLE: Chief of Staff");
    expect(args[2]).toContain("status please");
    expect(args[2]).toContain(REPO);
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args.join(" ")).not.toContain("dangerously-skip-permissions");
    expect(argv()[3]).toBe(join(dir, "chief"));
  });

  // Live 2026-10-11: claude wrote `gh pr view 16 -R <repo>`, which the `gh pr view -R <repo>` prefix rule refuses.
  it("the brief shows the number after -R <repo> and says to retry a refused command in that form", () => {
    const brief = readFileSync(join(BRIEFS, "chief.md"), "utf8");
    expect(brief).toContain("gh pr view -R owner/repo 16");
    expect(brief).toMatch(/refused.*-R <repo> right after the subcommand/s);
  });

  it("CHIEF_MODEL overrides haiku", () => {
    claudeDone("ok\n");
    chief(["status"], { CHIEF_MODEL: "sonnet" });
    const args = claudeArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("reads the request from stdin when no argument is given, as literal text", () => {
    claudeDone("ok\n");
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", input: `it's "quoted" $(not run)\n`, env: env() });
    expect(r.status).toBe(0);
    expect(claudeArgs()[2]).toContain(`it's "quoted" $(not run)`);
  });

  it("allows gh only on the team repos, and denies merges, raw API calls, pushes, rm, curl and edits", () => {
    claudeDone("ok\n");
    chief(["status"]);
    const all = argv();
    const allowed = flagValues(all, "--allowedTools");
    const denied = flagValues(all, "--disallowedTools");
    expect(allowed).toEqual(expect.arrayContaining([
      `Bash(gh issue list -R ${REPO}:*)`, `Bash(gh issue create -R ${REPO}:*)`, `Bash(gh issue edit -R ${REPO}:*)`,
      `Bash(gh pr view -R ${REPO}:*)`, `Bash(gh pr list -R ${REPO}:*)`, `Bash(gh pr checks -R ${REPO}:*)`,
      `Bash(gh pr edit -R ${REPO}:*)`,
    ]));
    for (const a of allowed) expect(a).toContain(`-R ${REPO}`);
    expect(allowed.join(" ")).not.toMatch(/gh pr merge|gh api|git push/);
    expect(denied).toEqual(expect.arrayContaining(["Bash(gh pr merge:*)", "Bash(gh api:*)", "Bash(git push:*)",
      "Bash(rm:*)", "Bash(curl:*)", "Edit", "Write"]));
  });

  it("reports claude's text when it took no action", () => {
    claudeDone("owner/sandbox issue #3 agent:plan - planning\nNothing needs you.\n");
    expect(chief(["status"]).out).toBe("owner/sandbox issue #3 agent:plan - planning\nNothing needs you.");
  });

  it("reports a failed claude run with its last lines", () => {
    claudeDone("Error: gh not logged in\n", "exit=1");
    const r = chief(["status"]);
    expect(r.out).toMatch(/^claude stopped with exit=1/);
    expect(r.out).toContain("Error: gh not logged in");
  });
});

describe("chief-run: a run still going after the wait", () => {
  it('prints "still running: chief-<id>" and --status returns the result later', () => {
    writeFileSync(join(fake, "state"), "running\n");
    const r = chief(["status"]);
    const name = /^still running: (chief-[a-zA-Z0-9-]+)/.exec(r.out)?.[1] ?? "";
    expect(name).not.toBe("");
    expect(readFileSync(join(fake, "started"), "utf8").trim()).toBe(name);
    claudeDone("all quiet\n");
    expect(chief(["--status", name]).out).toBe("all quiet");
  });

  // Live 2026-10-11: the Dot sent "merge PR 16" as three parallel shell calls in one model step.
  it("the same words again within 90 s join the run already started instead of starting another", () => {
    writeFileSync(join(fake, "state"), "running\n");
    const first = /^still running: (chief-[a-zA-Z0-9-]+)/.exec(chief(["merge PR 16"]).out)?.[1] ?? "";
    expect(first).not.toBe("");
    expect(chief(["merge PR 16"]).out).toContain(`still running: ${first}`);
    claudeDone("all quiet\n");
    expect(chief(["merge PR 16"]).out).toBe("all quiet");
    expect(readFileSync(join(fake, "started"), "utf8").trim().split("\n")).toEqual([first]);
  });

  it("different words, or the same words after 90 s, start a new run", () => {
    claudeDone("all quiet\n");
    chief(["status"]);
    chief(["new issue: x"]);
    const [name] = readFileSync(join(fake, "started"), "utf8").trim().split("\n");
    writeFileSync(join(runs, `${name}.meta`), `claude ${Math.floor(Date.now() / 1000) - 100}\n`);
    chief(["status"]);
    expect(readFileSync(join(fake, "started"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("refuses an unknown or malformed run name", () => {
    expect(chief(["--status", "chief-nope"]).out).toContain("no such chief run");
    expect(chief(["--status", "../etc"]).status).not.toBe(0);
  });
});

describe("chief-run: claude usage limit", () => {
  const LIMIT = "You've hit your weekly limit · resets Oct 12, 6am (UTC)\n";

  it("reruns the same request with agy, with the same allowlist as agy rules", () => {
    agyLogin();
    claudeDone(LIMIT, "exit=1");
    writeFileSync(join(fake, "agy-state"), "exit=0\n");
    writeFileSync(join(fake, "agy-log"), "agy says: 1 item open\n");
    const r = chief(["new issue: add /health"]);
    const agy = argv("agy-argv");
    const args = agy.slice(agy.indexOf("agy"));
    expect(args.slice(0, 2)).toEqual(["agy", "--new-project"]);
    expect(args[args.indexOf("--print") + 1]).toContain("new issue: add /health");
    expect(args[args.indexOf("--print") + 1]).toContain("YOUR ROLE: Chief of Staff");
    expect(args.join(" ")).not.toContain("dangerously-skip-permissions");
    const s = JSON.parse(readFileSync(join(dir, "home", ".gemini", "antigravity-cli", "settings.json"), "utf8")) as
      { permissions: { allow: string[]; deny: string[] } };
    expect(s.permissions.allow).toContain(`command(gh issue create -R ${REPO})`);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["command(gh pr merge)", "command(gh api)"]));
    expect(r.out).toContain("claude is at its usage limit; agy did this");
    expect(r.out).toContain("agy says: 1 item open");
  });

  it("with no agy login prints the exact message", () => {
    claudeDone(LIMIT, "exit=1");
    expect(chief(["status"]).out).toBe("claude is at its limit and this computer has no agy login; dot-login agy start");
    expect(existsSync(join(fake, "agy-started"))).toBe(false);
  });

  it("CHIEF_FORCE_LIMIT=1 fakes only the limit text: claude never starts and agy does the request", () => {
    agyLogin();
    writeFileSync(join(fake, "state"), "exit=1\n");
    writeFileSync(join(fake, "log"), "You've hit your usage limit (CHIEF_FORCE_LIMIT test)\n");
    writeFileSync(join(fake, "agy-state"), "exit=0\n");
    writeFileSync(join(fake, "agy-log"), "done by agy\n");
    const r = chief(["status"], { CHIEF_FORCE_LIMIT: "1" });
    expect(argv()).not.toContain("claude");
    expect(argv().join(" ")).toContain("CHIEF_FORCE_LIMIT");
    expect(existsSync(join(fake, "agy-started"))).toBe(true);
    expect(r.out).toContain("done by agy");
  });
});

describe("chief-run: actions are checked on GitHub, not taken from claude's words", () => {
  it("issue-created with agent:plan → ✓ with the link", () => {
    world([issue(12, ["agent:plan"])]);
    claudeDone(`Filed it.\nACTION issue-created ${REPO} 12\n`);
    const r = chief(["new issue: add /health"]);
    expect(r.out).toBe(`✓ issue-created ${REPO}#12 (agent:plan) https://github.com/${REPO}/issues/12`);
  });

  it("issue-created without agent:plan, or an old issue, or a missing one → ✗", () => {
    world([issue(12, []), issue(13, ["agent:plan"], { created_at: OLD })]);
    claudeDone(`ACTION issue-created ${REPO} 12\nACTION issue-created ${REPO} 13\nACTION issue-created ${REPO} 99\n`);
    const lines = chief(["new issue"]).out.split("\n");
    expect(lines[0]).toMatch(/^✗ issue-created owner\/sandbox#12: .*no agent:plan/);
    expect(lines[1]).toMatch(/^✗ issue-created owner\/sandbox#13: .*created before this run/);
    expect(lines[2]).toMatch(/^✗ issue-created owner\/sandbox#99: .*not found/i);
  });

  it("label → ✓ only when GitHub shows it", () => {
    world([issue(4, ["agent:plan"])]);
    claudeDone(`ACTION label ${REPO} 4 agent:plan\nACTION label ${REPO} 4 agent:build\n`);
    const lines = chief(["unblock 4"]).out.split("\n");
    expect(lines[0]).toBe(`✓ label ${REPO}#4 agent:plan`);
    expect(lines[1]).toBe(`✗ label ${REPO}#4 agent:build: labels are agent:plan`);
  });

  it("commented → ✓ only when a comment was made during this run", () => {
    world([issue(4, [], { comments: [{ created_at: NEW }] }), issue(5, [], { comments: [{ created_at: OLD }] })]);
    claudeDone(`ACTION commented ${REPO} 4\nACTION commented ${REPO} 5\n`);
    const lines = chief(["answer"]).out.split("\n");
    expect(lines[0]).toBe(`✓ commented ${REPO}#4`);
    expect(lines[1]).toMatch(/^✗ commented owner\/sandbox#5: no comment since/);
  });

  it("an action on a repo outside TEAM_REPOS → ✗", () => {
    claudeDone("ACTION label other/repo 1 agent:plan\n");
    expect(chief(["x"]).out).toBe("✗ label other/repo#1: not a team repo");
  });

  it("an unknown or malformed ACTION line → ✗", () => {
    claudeDone(`ACTION deleted ${REPO} 1\nACTION label ${REPO} abc agent:plan\n`);
    const lines = chief(["x"]).out.split("\n");
    expect(lines[0]).toBe(`✗ unreadable action: ACTION deleted ${REPO} 1`);
    expect(lines[1]).toBe(`✗ unreadable action: ACTION label ${REPO} abc agent:plan`);
  });

  it("claude claims an action but prints no ACTION line → NOT VERIFIED", () => {
    claudeDone("Done! I merged PR 5 and created issue 9.\n");
    const r = chief(["merge 5"]);
    expect(r.out).toContain("Done! I merged PR 5");
    expect(r.out).toContain("NOT VERIFIED - claude says it acted but printed no ACTION line");
  });
});

describe("chief-run: merges are founder-named and agent:approved, and the script does them", () => {
  it("merges a named, approved PR, checks MERGED, and closes the issue it fixes", () => {
    world([pr(16, ["agent:approved"], { closes: [7] }), issue(7, ["agent:in-pr"])]);
    claudeDone(`ACTION merged ${REPO} 16\n`);
    const r = chief(["merge PR 16"]);
    expect(r.out).toBe(`✓ merged ${REPO}#16 into beta https://github.com/${REPO}/pull/16\n✓ closed ${REPO}#7`);
    expect(find(16).state).toBe("MERGED");
    expect(find(7).state).toBe("CLOSED");
    expect(ghLog()).toContain(`pr merge 16 -R ${REPO} --merge`);
  });

  it("gh still shows OPEN after the merge command → ✗, and nothing says done", () => {
    world([pr(16, ["agent:approved"])]);
    writeFileSync(join(fake, "merge-fails"), "");
    claudeDone(`Done, merged.\nACTION merged ${REPO} 16\n`);
    const r = chief(["merge PR 16"]);
    expect(r.out).toMatch(/^✗ merged owner\/sandbox#16: state OPEN/);
    expect(r.out).toContain("not mergeable");
    expect(r.out).not.toMatch(/done|✓/i);
    expect(find(16).state).toBe("OPEN");
  });

  it("refuses a PR the founder did not name", () => {
    world([pr(16, ["agent:approved"]), pr(161, ["agent:approved"])]);
    claudeDone(`ACTION merged ${REPO} 16\n`);
    const r = chief(["merge PR 161"]);
    expect(r.out).toBe(`✗ merged ${REPO}#16: refused, the founder did not name PR 16`);
    expect(ghLog()).not.toContain("pr merge");
    expect(find(16).state).toBe("OPEN");
  });

  it("refuses a PR without agent:approved", () => {
    world([pr(16, ["agent:review"])]);
    claudeDone(`ACTION merged ${REPO} 16\n`);
    const r = chief(["merge PR 16"]);
    expect(r.out).toBe(`✗ merged ${REPO}#16: refused, PR 16 has no agent:approved (labels: agent:review)`);
    expect(ghLog()).not.toContain("pr merge");
  });

  // Stacked PRs (team-shift): PR 41's base is PR 40's branch. Merged there, its code would never reach beta.
  it("refuses a stacked PR while the PR under it is open", () => {
    world([pr(40, ["agent:approved"], { head: "feat/a" }), pr(41, ["agent:approved"], { head: "feat/b", base: "feat/a" })]);
    claudeDone(`ACTION merged ${REPO} 41\n`);
    const r = chief(["merge PR 41"]);
    expect(r.out).toBe(`✗ merged ${REPO}#41: refused, it is stacked on PR 40, which is not merged yet. Merge 40 first`);
    expect(ghLog()).not.toContain("pr merge");
    expect(find(41).state).toBe("OPEN");
  });

  it("merges a whole stack named in order: each PR moves onto beta once the one under it is merged", () => {
    world([pr(40, ["agent:approved"], { head: "feat/a" }), pr(41, ["agent:approved"], { head: "feat/b", base: "feat/a" }),
      pr(42, ["agent:approved"], { head: "feat/c", base: "feat/b" })]);
    claudeDone(`ACTION merged ${REPO} 40\nACTION merged ${REPO} 41\nACTION merged ${REPO} 42\n`);
    const r = chief(["merge 40, 41 and 42"]);
    expect(r.out).toBe([40, 41, 42].map((n) => `✓ merged ${REPO}#${n} into beta https://github.com/${REPO}/pull/${n}`).join("\n"));
    expect(ghLog()).toContain(`pr edit 41 -R ${REPO} --base beta`);
    expect(ghLog()).toContain(`pr edit 42 -R ${REPO} --base beta`);
    expect(ghLog()).not.toContain("pr edit 40");
  });

  it("a stacked PR that cannot be moved onto beta is not merged into the other PR's branch", () => {
    world([pr(40, ["agent:approved"], { head: "feat/a", state: "MERGED" }), pr(41, ["agent:approved"], { head: "feat/b", base: "feat/a" })]);
    writeFileSync(join(fake, "edit-fails"), "");
    claudeDone(`ACTION merged ${REPO} 41\n`);
    const r = chief(["merge PR 41"]);
    expect(r.out).toMatch(/^✗ merged owner\/sandbox#41: could not move it onto beta after PR 40 was merged/);
    expect(ghLog()).not.toContain("pr merge");
  });

  it("--status checks merges against the request of the original turn", () => {
    world([pr(16, ["agent:approved"])]);
    writeFileSync(join(fake, "state"), "running\n");
    const name = /still running: (chief-[a-zA-Z0-9-]+)/.exec(chief(["merge PR 16"]).out)?.[1] ?? "";
    claudeDone(`ACTION merged ${REPO} 16\n`);
    expect(chief(["--status", name]).out).toMatch(/^✓ merged owner\/sandbox#16/);
  });
});

describe("chief-run: live findings 2026-10-12", () => {
  it("verifies ACTION closed on GitHub (claude closed #24 and chief-run called the line unreadable)", () => {
    world([issue(24, ["agent:blocked"], { state: "CLOSED" }), issue(25, ["agent:blocked"])]);
    claudeDone("Closed #24.\nACTION closed owner/sandbox 24\nACTION closed owner/sandbox 25\n");
    const out = chief(["Issue 24 in sandbox: close it as done."]).out;
    expect(out).toContain("✓ closed owner/sandbox#24");
    expect(out).toContain("✗ closed owner/sandbox#25: state is open");
    expect(out).not.toContain("unreadable");
  });

  it("gives claude the previous turn as context, so a follow-up need not repeat the repo", () => {
    claudeDone("Ready to merge: PR 23 in owner/sandbox.\n");
    chief(["what is waiting on me?"]);
    claudeDone("ok\n");
    chief(["Merge PR 23."]);
    const prompt = claudeArgs()[2] ?? "";
    expect(prompt).toContain("PREVIOUS TURN");
    expect(prompt).toContain("what is waiting on me?");
    expect(prompt).toContain("Ready to merge: PR 23 in owner/sandbox.");
    expect(prompt.indexOf("PREVIOUS TURN")).toBeLessThan(prompt.indexOf("Merge PR 23."));
  });

  it("the brief asks for the blocker question on every blocked item, and lists the closed action", () => {
    const brief = readFileSync(join(BRIEFS, "chief.md"), "utf8");
    expect(brief).toMatch(/agent:blocked[^\n]*question/);
    expect(brief).toContain("ACTION closed <repo> <number>");
  });
});

