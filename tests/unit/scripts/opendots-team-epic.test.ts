/**
 * Epic branch (deploy/opendots/team-shift, team-lib.sh): a big task is split into parts; each part's PR is built on
 * feat/epic-<P>, reviewed alone, and merged into that branch by team-shift once approved. One final PR goes to the
 * founder. Code in deploy/opendots only; no model, no network (fake gh, fake git, fake run-bg).
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
const FAKES = join(ROOT, "tests", "unit", "scripts", "fakes");
const REPO = "owner/sandbox";
const URL_PREFIX = `https://github.com/${REPO}`;

interface Item { repo: string; kind: "issue" | "pr"; number: number; labels: string[]; createdAt: string; comments: string[]; title?: string; body?: string; state?: string; head?: string; base?: string }

let dir: string;
let fake: string;
let runs: string;

function bin(name: string, body: string): void {
  const path = join(fake, "bin", name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const fakeScript = (file: string): string => readFileSync(join(FAKES, file), "utf8");

function world(items: Item[]): void {
  writeFileSync(join(fake, "items.json"), JSON.stringify(items));
  writeFileSync(join(fake, "has-beta"), "");
}
const items = (): Item[] => JSON.parse(readFileSync(join(fake, "items.json"), "utf8")) as Item[];
function item(kind: string, n: number): Item {
  const found = items().find((i) => i.kind === kind && i.number === n);
  if (!found) throw new Error(`no ${kind} #${n}`);
  return found;
}
function setItem(kind: string, n: number, patch: Partial<Item>): void {
  writeFileSync(join(fake, "items.json"), JSON.stringify(items().map((i) => (i.kind === kind && i.number === n ? { ...i, ...patch } : i))));
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
      TEAM_LOCAL_RULES: join(dir, "rules"),
      HOME: join(dir, "home"),
      TEAM_RETRY_SLEEP: "0",
    },
  });
  return { out: r.stdout.trim(), status: r.status, err: r.stderr };
}
const claudeArgs = (): string[] => {
  const all = readFileSync(join(fake, "argv"), "utf8").split("\0");
  return all.slice(all.indexOf("claude"));
};
const prompt = (): string => claudeArgs()[2] ?? "";
/** Only the per-item part of the prompt: the role briefs name every case, so they cannot tell which one applied. */
const thisShift = (): string => prompt().split("\nTHIS SHIFT\n")[1] ?? "";
const gitLog = (): string => readFileSync(join(fake, "git.log"), "utf8");
const ghLog = (): string => readFileSync(join(fake, "gh.log"), "utf8");
const pushes = (): string[] => gitLog().split("\n").filter((l) => / push origin /.test(l));
const prs = (): Item[] => items().filter((i) => i.kind === "pr");

function writeJob(role: string, kind: string, n: number): void {
  const started = Math.floor(Date.now() / 1000) - 60;
  writeFileSync(join(runs, `shift-${role}.job`), `${REPO} ${kind} ${n} shift-${role}-sandbox-${n}-1 ${started}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "team-epic-"));
  fake = join(dir, "fake");
  runs = join(dir, "runs");
  spawnSync("mkdir", ["-p", join(fake, "bin"), runs]);
  bin("gh", fakeScript("opendots-gh.sh"));
  bin("run-bg", fakeScript("opendots-run-bg.sh"));
  bin("tmux", "#!/bin/sh\nexit 0\n");
  // A git that remembers which branches exist on origin ($FAKE/branches): push creates one, rev-parse finds it.
  bin("git", [
    "#!/bin/sh",
    'printf \'%s\\n\' "$*" >> "$FAKE/git.log"',
    'all="$*"',
    'case "$all" in',
    '  *"rev-parse -q --verify refs/remotes/origin/"*) b=${all##*refs/remotes/origin/}; grep -qx "$b" "$FAKE/branches" 2>/dev/null; exit $? ;;',
    '  *" push origin "*) [ -e "$FAKE/push-fails" ] && { echo "remote: Permission to owner/sandbox.git denied to dot-builder." >&2; exit 128; }',
    '    b=${all##*:refs/heads/}; echo "$b" >> "$FAKE/branches"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "repos"), `# team repos\n${REPO}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const issue = (number: number, labels: string[], more: Partial<Item> = {}): Item =>
  ({ repo: REPO, kind: "issue", number, labels, createdAt: "2026-10-10T10:00:00Z", comments: [], ...more });
const pr = (number: number, labels: string[], more: Partial<Item> = {}): Item =>
  ({ repo: REPO, kind: "pr", number, labels, createdAt: `2026-10-10T10:${String(number % 60).padStart(2, "0")}:00Z`, comments: [], ...more });

const parent = (labels = ["agent:epic"], more: Partial<Item> = {}): Item =>
  issue(35, labels, { title: "Add the stats command", body: "Goal: a stats command.\n\nDone when: it prints the totals.", ...more });
const part = (number: number, more: Partial<Item> = {}): Item =>
  issue(number, ["agent:build"], { title: `Part ${number}`, body: `Part of #35.\n\nGoal: part ${number}.`, createdAt: `2026-10-10T10:${number}:00Z`, ...more });
/** A part issue that has its PR: counted as a child of the epic. */
const child = (number: number, more: Partial<Item> = {}): Item =>
  issue(number, ["agent:in-pr"], { title: `Part ${number}`, body: `Part of #35.\n\nGoal: part ${number}.`, ...more });
/** A part's PR, built on the epic branch. */
const partPr = (number: number, closes: number, labels: string[], more: Partial<Item> = {}): Item =>
  pr(number, labels, { title: `Part ${closes}`, body: `What changed: x\n\nCloses #${closes}`, head: `feat/part-${closes}`, base: "feat/epic-35", ...more });
const EPIC_BRANCH = "feat/epic-35";

describe("epic branch: a Builder starts on a part of an epic", () => {
  it("creates feat/epic-P once from the base, then builds on it", () => {
    world([parent(), part(37)]);
    const r = shift("builder");
    expect(r.out, r.err).toMatch(/^Started: owner\/sandbox issue #37, claude run /);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toContain(`push origin origin/beta:refs/heads/${EPIC_BRANCH}`);
    expect(gitLog()).toMatch(/fetch -q origin[\s\S]*checkout -q --detach origin\/feat\/epic-35/);
    expect(prompt()).toContain(`Base branch: ${EPIC_BRANCH}.`);
    expect(prompt()).toContain("part of epic #35");
    expect(prompt()).toContain(`gh pr create --draft --base ${EPIC_BRANCH}`);
    expect(prompt()).toContain(`never push to ${EPIC_BRANCH} itself`);
    // The second part finds the branch and does not push again.
    spawnSync("rm", ["-f", join(runs, "shift-builder.job")]);
    world([parent(), part(38)]);
    expect(shift("builder").out).toMatch(/^Started: owner\/sandbox issue #38/);
    expect(pushes()).toHaveLength(1);
    expect(prompt()).toContain(`Base branch: ${EPIC_BRANCH}.`);
  });

  it("a part that builds on another part keeps that part's branch as its base", () => {
    world([parent(), issue(36, ["agent:in-pr"]), pr(40, ["agent:review"], { body: "Closes #36", head: "feat/part-36", base: EPIC_BRANCH }),
      part(37, { body: "Part of #35.\nBuilds on: #36\n\nGoal: part 37." })]);
    const r = shift("builder");
    expect(r.out, r.err).toMatch(/^Started: owner\/sandbox issue #37/);
    expect(prompt()).toContain("Base branch: feat/part-36.");
    expect(prompt()).toContain("gh pr create --draft --base feat/part-36");
    expect(prompt()).not.toContain(`gh pr create --draft --base ${EPIC_BRANCH}`);
    expect(prompt()).toContain("part of epic #35");
    expect(gitLog()).toContain("checkout -q --detach origin/feat/part-36");
  });

  it("an issue whose parent is not an epic starts from the normal base and creates no branch", () => {
    world([parent(["agent:in-pr"]), part(37)]);
    expect(shift("builder").out).toMatch(/^Started: owner\/sandbox issue #37/);
    expect(prompt()).toContain("Base branch: beta.");
    expect(thisShift()).not.toContain("part of epic");
    expect(pushes()).toHaveLength(0);
  });

  it("an issue with no Part of line, and one whose parent does not exist, start from the normal base", () => {
    world([issue(50, ["agent:build"], { body: "Goal: small." })]);
    expect(shift("builder").out).toMatch(/^Started: owner\/sandbox issue #50/);
    expect(prompt()).toContain("Base branch: beta.");
    spawnSync("rm", ["-f", join(runs, "shift-builder.job")]);
    world([part(37)]); // #35 is not in the world: GitHub cannot resolve it
    expect(shift("builder").out).toMatch(/^Started: owner\/sandbox issue #37/);
    expect(prompt()).toContain("Base branch: beta.");
    expect(pushes()).toHaveLength(0);
  });

  it("blocks the item with the git error when the epic branch cannot be created", () => {
    world([parent(), part(37)]);
    writeFileSync(join(fake, "push-fails"), "");
    const r = shift("builder");
    expect(r.out).toMatch(/^Blocked: owner\/sandbox issue #37\. Builder: could not create feat\/epic-35/);
    expect(item("issue", 37).labels).toEqual(["agent:blocked"]);
    expect(item("issue", 37).comments.join("\n")).toContain("Permission to owner/sandbox.git denied");
    expect(existsSync(join(fake, "started"))).toBe(false);
  });

  it("a lookup GitHub refuses fails the shift instead of starting the part on the wrong base", () => {
    world([parent(), part(37)]);
    writeFileSync(join(fake, "view-labels-fails"), "");
    const r = shift("builder");
    expect(r.status).not.toBe(0);
    expect(existsSync(join(fake, "started"))).toBe(false);
    expect(item("issue", 37).labels).toEqual(["agent:build"]);
  });

  it("an epic part's PR sent back with changes is rebuilt against its own base", () => {
    world([parent(), partPr(41, 37, ["agent:changes"])]);
    expect(shift("builder").out).toMatch(/^Started: owner\/sandbox pr #41/);
    expect(prompt()).toContain(`Base branch: ${EPIC_BRANCH}.`);
    expect(thisShift()).not.toContain("Stacked PR");
  });
});

describe("epic branch: team-shift merges an approved part into feat/epic-P", () => {
  it("--check lists an approved part as work, before the review queue, and changes nothing", () => {
    world([pr(30, ["agent:review"], { createdAt: "2026-10-01T10:00:00Z" }), partPr(41, 37, ["agent:approved"])]);
    const r = shift("reviewer", "--check");
    expect(r.out, r.err).toBe(`Due: ${REPO} pr #41 (approved part: merge into ${EPIC_BRANCH})`);
    expect(ghLog()).not.toContain("pr merge");
    expect(ghLog().split("\n").filter((l) => l.startsWith("api graphql"))).toHaveLength(1);
    expect(item("pr", 41).state).toBeUndefined();
    expect(existsSync(join(runs, "shift-reviewer.job"))).toBe(false);
  });

  it("an approved PR that is not on an epic branch is not work", () => {
    world([pr(60, ["agent:approved"]), pr(61, ["agent:approved"], { base: "feat/part-36", head: "feat/part-37" }), pr(62, ["agent:approved"], { base: "feat/epic-x" })]);
    expect(shift("reviewer", "--check").out).toBe("No work");
    expect(shift("reviewer").out).toBe("No work");
    expect(ghLog()).not.toContain("pr merge");
  });

  it("a review claimed earlier still comes before an approved part", () => {
    world([pr(30, ["agent:reviewing"]), partPr(41, 37, ["agent:approved"])]);
    expect(shift("reviewer", "--check").out).toBe("Due: owner/sandbox pr #30 (agent:reviewing)");
  });

  it("merges the part with a merge commit, retargets the PR stacked on it, closes its issue, and counts the parts", () => {
    world([parent(), child(37), child(38, { body: "Part of #35.\nBuilds on: #37" }),
      partPr(41, 37, ["agent:approved"]), partPr(42, 38, ["agent:review"], { base: "feat/part-37" })]);
    const r = shift("reviewer");
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe(`Done: ${REPO} pr #41.\nRESULT: merged into ${EPIC_BRANCH} (1 of 2 parts)`);
    expect(ghLog()).toContain(`pr merge 41 -R ${REPO} --merge`);
    expect(ghLog()).not.toMatch(/--squash|--delete-branch|--admin|--auto/);
    expect(item("pr", 41).state).toBe("MERGED");
    expect(item("pr", 41).labels).not.toContain("agent:approved");
    expect(item("pr", 42).base).toBe(EPIC_BRANCH);
    expect(item("issue", 37).state).toBe("CLOSED");
    expect(item("issue", 37).comments).toEqual([`Merged in ${URL_PREFIX}/pull/41 into ${EPIC_BRANCH}.`]);
    expect(item("issue", 38).state).toBeUndefined();
    expect(prs().filter((p) => p.head === EPIC_BRANCH)).toHaveLength(0); // part 38 is still open: no final PR
    expect(existsSync(join(runs, "shift-reviewer.job"))).toBe(false);
    expect(readFileSync(join(runs, "last-reviewer.txt"), "utf8")).toContain(`RESULT: merged into ${EPIC_BRANCH} (1 of 2 parts)`);
  });

  it("opens the final PR when the last part is merged, draft onto the base with agent:review, and only once", () => {
    world([parent(), child(37, { state: "CLOSED" }), child(38), partPr(41, 37, [], { state: "MERGED" }), partPr(42, 38, ["agent:approved"])]);
    // Part 37 is closed and merged already: this merge is the last one.
    const r = shift("reviewer");
    expect(r.status, r.err).toBe(0);
    const final = prs().filter((p) => p.head === EPIC_BRANCH);
    expect(final).toHaveLength(1);
    expect(r.out).toBe(`Done: ${REPO} pr #42.\nRESULT: merged into ${EPIC_BRANCH} (2 of 2 parts); final PR #${final[0]?.number} is in review`);
    expect(final[0]).toMatchObject({ base: "beta", labels: ["agent:review"], title: "Add the stats command", draft: true });
    const body = final[0]?.body ?? "";
    expect(body).toContain("Closes #35");
    expect(body).toContain("#41");
    expect(body).toContain("#42");
    expect(body).toMatch(/What changed/);
    expect(body).toMatch(/How it was verified/);
    expect(body).toMatch(/NOT VERIFIED/);
    expect(body).toMatch(/integration review pending/);
    expect(ghLog()).toContain(`pr create -R ${REPO} --draft --base beta --head ${EPIC_BRANCH} --title Add the stats command --label agent:review`);
    // The merge is retried (a lost label edit, a crashed shift): the final PR is not opened a second time.
    setItem("pr", 42, { labels: ["agent:approved"] });
    const again = shift("reviewer");
    expect(again.status, again.err).toBe(0);
    expect(prs().filter((p) => p.head === EPIC_BRANCH)).toHaveLength(1);
    expect(again.out).toBe(`Done: ${REPO} pr #42.\nRESULT: merged into ${EPIC_BRANCH} (2 of 2 parts)`);
  });

  it("opens no final PR while another PR is still open onto the epic branch", () => {
    world([parent(), child(37), child(38, { state: "CLOSED" }),
      partPr(41, 37, ["agent:approved"]), partPr(43, 99, ["agent:review"])]);
    const r = shift("reviewer");
    expect(r.out).toBe(`Done: ${REPO} pr #41.\nRESULT: merged into ${EPIC_BRANCH} (1 of 2 parts)`);
    expect(prs().filter((p) => p.head === EPIC_BRANCH)).toHaveLength(0);
  });

  it("a merge GitHub refuses sends the part back to the Builder with the reason, and opens no final PR", () => {
    world([parent(), child(37), partPr(41, 37, ["agent:approved"])]);
    writeFileSync(join(fake, "merge-fails"), "");
    const r = shift("reviewer");
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`^Done: ${REPO} pr #41\\.\\nRESULT: .*could not merge into ${EPIC_BRANCH}.*sent back to the Builder`));
    expect(item("pr", 41).state).toBeUndefined();
    expect(item("pr", 41).labels).toEqual(["agent:changes"]);
    const note = item("pr", 41).comments[0] ?? "";
    expect(note).toBe(`team-shift: could not merge this approved part into ${EPIC_BRANCH} (X Pull request ${REPO}#41 is not mergeable: the merge commit cannot be cleanly created.). Builder: merge origin/${EPIC_BRANCH} into this branch, fix the conflicts, rerun the checks, push.`);
    expect(note).not.toMatch(/^Reviewer verdict: CHANGES/);
    expect(item("issue", 37).state).toBeUndefined();
    expect(prs().filter((p) => p.head === EPIC_BRANCH)).toHaveLength(0);
    expect(readFileSync(join(runs, "last-reviewer.txt"), "utf8")).toContain("sent back to the Builder");
    // It is the Builder's again, and the review-round count (Reviewer verdict: CHANGES) is untouched.
    expect(shift("builder", "--check").out).toBe("Due: owner/sandbox pr #41 (agent:changes)");
  });

  it("a GitHub error midway fails the shift, leaves the part merged and marked, and the next shift finishes the rest", () => {
    world([parent(), child(37, { state: "CLOSED" }), child(38),
      partPr(41, 37, [], { state: "MERGED" }), partPr(42, 38, ["agent:approved"]), pr(43, ["agent:building"], { head: "feat/part-39", base: "feat/part-38" })]);
    writeFileSync(join(fake, "retarget-fails"), "");
    const failed = shift("reviewer");
    expect(failed.status).not.toBe(0);
    expect(failed.err).toContain("Base branch was modified");
    expect(item("pr", 42).state).toBe("MERGED");
    expect(item("pr", 42).labels).toContain("agent:approved"); // the marker stays until every step is done
    expect(existsSync(join(runs, "shift-reviewer.job"))).toBe(false);
    spawnSync("rm", ["-f", join(fake, "retarget-fails")]);
    expect(shift("reviewer", "--check").out).toBe(`Due: ${REPO} pr #42 (approved part: merge into ${EPIC_BRANCH})`);
    const ok = shift("reviewer");
    expect(ok.status, ok.err).toBe(0);
    expect(ok.out).toContain(`Done: ${REPO} pr #42.\nRESULT: merged into ${EPIC_BRANCH} (2 of 2 parts)`);
    expect(item("pr", 43).base).toBe(EPIC_BRANCH);
    expect(item("issue", 38).state).toBe("CLOSED");
    expect(item("pr", 42).labels).not.toContain("agent:approved");
    expect(shift("reviewer", "--check").out).toBe("No work");
  });

  it("a failed final PR leaves the part marked so the next shift opens it", () => {
    world([parent(), child(37), partPr(41, 37, ["agent:approved"])]);
    writeFileSync(join(fake, "pr-create-fails"), "");
    const failed = shift("reviewer");
    expect(failed.status).not.toBe(0);
    expect(failed.err).toContain("createPullRequest");
    expect(item("pr", 41).labels).toContain("agent:approved");
    spawnSync("rm", ["-f", join(fake, "pr-create-fails")]);
    const ok = shift("reviewer");
    expect(ok.out).toMatch(new RegExp(`final PR #\\d+ is in review$`));
    expect(prs().filter((p) => p.head === EPIC_BRANCH)).toHaveLength(1);
  });
});

describe("epic branch: the final PR and the stacked-PR line", () => {
  it("the Reviewer on the final PR is told to review how the parts fit together", () => {
    world([parent(), pr(43, ["agent:review"], { head: EPIC_BRANCH, base: "beta", body: "Closes #35" })]);
    expect(shift("reviewer").out).toMatch(/^Started: owner\/sandbox pr #43/);
    expect(prompt()).toContain("Base branch: beta.");
    expect(prompt()).toContain("Integration review");
    expect(prompt()).toContain("every part was already reviewed alone");
    expect(thisShift()).not.toContain("Stacked PR");
  });

  it("an ordinary PR gets no integration-review line", () => {
    world([pr(44, ["agent:review"])]);
    shift("reviewer");
    expect(thisShift()).not.toContain("Integration review");
  });

  it("the Builder is told what to do with a CHANGES round on the final PR", () => {
    world([parent(), pr(43, ["agent:changes"], { head: EPIC_BRANCH, base: "beta", body: "Closes #35" })]);
    expect(shift("builder").out).toMatch(/^Started: owner\/sandbox pr #43/);
    expect(prompt()).toContain("Base branch: beta.");
    expect(readFileSync(join(BRIEFS, "builder.md"), "utf8").replace(/\s+/g, " ")).toMatch(/final PR.*push.*feat\/epic-P.*own branch/i);
  });

  it("a PASS on a part prints no merge order, even when another part is stacked on it", () => {
    world([partPr(41, 37, ["agent:approved"]), partPr(42, 38, ["agent:approved"], { base: "feat/part-37" })]);
    writeJob("reviewer", "pr", 42);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), "RESULT: PASS\n");
    const r = shift("reviewer");
    expect(r.out, r.err).toBe(`Done: ${REPO} pr #42. RESULT: PASS`);
    expect(readFileSync(join(runs, "last-reviewer.txt"), "utf8")).not.toContain("Merge order");
  });

  it("a stack that does not sit on an epic branch still prints its merge order", () => {
    world([pr(40, ["agent:approved"], { head: "feat/a" }), pr(41, ["agent:approved"], { head: "feat/b", base: "feat/a" })]);
    writeJob("reviewer", "pr", 41);
    writeFileSync(join(fake, "state"), "exit=0\n");
    writeFileSync(join(fake, "log"), "RESULT: PASS\n");
    expect(shift("reviewer").out).toContain("Merge order, first to last: #40 (approved), #41 (approved).");
  });
});

describe("epic branch: the briefs", () => {
  const brief = (role: string): string => readFileSync(join(BRIEFS, `${role}.md`), "utf8").replace(/\s+/g, " ");

  it("the Architect defaults to one PR and splits only when one Builder run cannot finish", () => {
    expect(brief("architect")).toMatch(/default is ONE PR/i);
    expect(brief("architect")).toMatch(/600 changed lines/);
    expect(brief("architect")).toMatch(/never split because the request says "parts"/i);
    expect(brief("architect")).toMatch(/feat\/epic-<P>/);
    expect(brief("architect")).toContain("Builds on: #N");
  });

  it("the Chief never tells the Architect how many parts to make", () => {
    expect(brief("chief")).toMatch(/never tell the Architect how many parts/i);
    expect(brief("chief")).toMatch(/epic.*parts merged.*final PR/i);
    expect(brief("chief")).toMatch(/never print ACTION merged for a part/i);
  });

  it("the Reviewer reads a big diff file by file, and the final PR as an integration review", () => {
    expect(brief("reviewer")).toMatch(/400 changed lines or 15 files/);
    expect(brief("reviewer")).toContain("gh pr diff N --name-only");
    expect(brief("reviewer")).toMatch(/unread file is NOT VERIFIED/i);
    expect(brief("reviewer")).toMatch(/Integration review/);
  });

  it("the Builder knows an epic part's PR goes onto the epic branch", () => {
    expect(brief("builder")).toMatch(/part of epic.*--base feat\/epic-P/i);
  });

  it("roles never get gh pr merge or gh api: only the script merges", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/denied=\("Bash\(gh pr merge:\*\)" "Bash\(gh api:\*\)"/);
    expect(src.match(/"Bash\(gh pr merge/g)).toHaveLength(1);
    expect(src.match(/"Bash\(gh api/g)).toHaveLength(1);
  });
});
