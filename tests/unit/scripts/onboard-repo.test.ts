/**
 * One command puts a repo on the loop — deploy/onboard-repo.sh.
 * ==============================================================
 * A repo was registered in three places and only two were checked against each other. The VPS
 * also needs /opt/review/<repo>, /opt/agy-workspace/<repo> owned by the antigravity user, and
 * six agent:* labels, each a manual step nobody could verify. On 2026-09-23 a repo was
 * allowlisted and advertised in /task's usage text while the daemon had never heard of it.
 *
 *   onboard-repo.sh <owner/repo>    provision what is missing, then print ONLY what it verified
 *   onboard-repo.sh --check         report what is missing, for every repo, and change nothing
 *
 * These run the real script against real git (clones come from local bare repos through
 * url.insteadOf, so nothing touches the network), a stateful fake gh for the labels, and a
 * fake sudo that records what it was asked to run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_LABELS, ENGINE_LABELS, DispatchSandbox } from "./dispatch-sandbox.js";

const REPO = "owner/widgets";
/** What a fully onboarded repo carries: the six agent:* state labels and the two engine:* labels. */
const ALL_LABELS = [...AGENT_LABELS, ...ENGINE_LABELS];
const SCRIPT = fileURLToPath(new URL("../../../deploy/onboard-repo.sh", import.meta.url));
const DAEMON = fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url));

let sb: DispatchSandbox;

/** Rows of `--check --porcelain`: repo, piece, status, detail. */
function rows(stdout: string): { repo: string; piece: string; status: string; detail: string }[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [repo = "", piece = "", status = "", ...rest] = l.split("\t");
      return { repo, piece, status, detail: rest.join("\t") };
    });
}

/** Everything under a directory, with each git ref, so "nothing changed" is checkable. */
function snapshot(dir: string): string {
  if (!existsSync(dir)) return "(absent)";
  const files = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.name === ".git" ? [] : e.isDirectory() ? files(join(d, e.name)).map((f) => `${e.name}/${f}`) : [`${e.name}:${statSync(join(d, e.name)).size}`],
    );
  const refs = existsSync(join(dir, ".git"))
    ? execFileSync("git", ["-C", dir, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" })
    : "";
  return `${files(dir).sort().join("\n")}\n${refs}`;
}

const mutatingSudo = () => sb.sudoCalls().filter((c) => /\b(mkdir|chown|clone)\b/.test(c));
const labelCreates = () => sb.ghCallList().filter((c) => c.startsWith("label create"));

beforeEach(() => {
  sb = new DispatchSandbox([REPO], { provision: false });
});

afterEach(() => {
  sb.destroy();
});

describe("onboard-repo.sh — the repo name is validated before anything runs", () => {
  const BAD: readonly (readonly [string, string])[] = [
    ["nothing", ""],
    ["an owner alone", "owner"],
    ["a missing name", "owner/"],
    ["a missing owner", "/repo"],
    ["a third path segment", "owner/repo/extra"],
    ["a space", "owner/repo name"],
    ["a semicolon command", "owner/repo;touch pwned"],
    ["a command substitution", "owner/repo$(touch pwned)"],
    ["a backtick substitution", "owner/`touch pwned`"],
    ["a pipe", "owner/repo|cat"],
    ["an ampersand", "owner/repo&"],
    ["a variable", "owner/$HOME"],
    ["a parent directory as the name", "owner/.."],
    ["a dot as the name", "owner/."],
    ["a parent directory as the owner", "../x/y"],
    ["a leading hyphen on the owner (an option)", "-rf/repo"],
    ["a leading hyphen on the name (an option)", "owner/-repo"],
    ["a space in the owner", "own er/repo"],
    ["a newline", "owner/repo\nx"],
    ["a non-ASCII owner", "ownér/repo"],
    ["an owner over 39 characters", `${"a".repeat(40)}/repo`],
    ["a name over 100 characters", `owner/${"a".repeat(101)}`],
  ];

  it.each(BAD)("rejects %s with exit 2 and runs nothing", (_what, arg) => {
    for (const args of [[arg], ["--check", arg], ["--check", "--porcelain", arg]]) {
      sb.clearCallLogs();
      const r = sb.onboard(args);

      expect(r.status, `args ${JSON.stringify(args)}`).toBe(2);
      expect(r.stderr).toMatch(/not a valid owner\/repo/);
      expect(sb.ghCallList()).toEqual([]);
      expect(sb.sudoCalls()).toEqual([]);
      expect(existsSync(join(sb.home, "pwned"))).toBe(false);
      expect(existsSync("pwned")).toBe(false);
      expect(existsSync(sb.reviewDir(REPO))).toBe(false);
    }
  });

  it("validates EVERY name up front: one bad name among good ones runs nothing at all", () => {
    const r = sb.onboard(["--check", REPO, "owner/bad name"]);
    expect(r.status).toBe(2);
    expect(sb.ghCallList()).toEqual([]);
  });

  it("accepts the shapes real repos have: dots, underscores, hyphens, digits, upper case", () => {
    for (const ok of ["pushkarverma3698/FounderOS", "OplifyMessage/oplify-messaging-app", "a/b", "org-1/my_repo.v2", "o/.github"]) {
      const r = sb.onboard(["--check", "--porcelain", ok]);
      expect(r.status, ok).not.toBe(2);
    }
  });

  it("needs exactly one repo to provision, and rejects unknown options", () => {
    expect(sb.onboard([]).status).toBe(2);
    expect(sb.onboard([REPO, "owner/other"]).status).toBe(2);
    expect(sb.onboard(["--frobnicate"]).status).toBe(2);
    expect(sb.onboard(["--help"]).status).toBe(0);
  });
});

describe("onboard-repo.sh <owner/repo> — provisioning", () => {
  it("clones the review checkout and the agy workspace, creates the eight labels, and prints what it VERIFIED", () => {
    sb.setRepoLabels(REPO, []);
    const r = sb.onboard([REPO]);

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(sb.reviewDir(REPO), ".git"))).toBe(true);
    expect(existsSync(join(sb.reviewDir(REPO), "README.md"))).toBe(true);
    expect(existsSync(join(sb.workspaceDir(REPO), ".git"))).toBe(true);
    expect([...sb.repoLabels(REPO)].sort()).toEqual([...ALL_LABELS].sort());

    expect(r.stdout).toMatch(/ok\s+review checkout\s+.*widgets/);
    expect(r.stdout).toMatch(/ok\s+agy workspace\s+.*widgets/);
    expect(r.stdout).toMatch(/ok\s+labels\s+8 of 8/);
    expect(r.stdout).not.toMatch(/MISSING|FAILED/);
  });

  it("clones the workspace as the antigravity user (through sudo), never as whoever ran the script", () => {
    sb.onboard([REPO]);

    const clone = sb.sudoCalls().find((c) => /\bgit clone\b/.test(c) && c.includes(sb.workspaceDir(REPO)));
    expect(clone, sb.sudoCalls().join("\n")).toBeDefined();
    expect(clone).toContain(`-u ${userInfo().username} --`);
    expect(clone).toContain("https://github.com/owner/widgets.git");
  });

  it("uses the same directory names the daemon uses, including its FounderOS special case", () => {
    const fx = new DispatchSandbox(["pushkarverma3698/FounderOS", "OplifyMessage/oplify-messaging-app", "owner/founderos-tools"], {
      provision: false,
    });
    try {
      const listed = rows(fx.onboard(["--check", "--porcelain"]).stdout);
      expect(listed.find((r) => r.repo === "pushkarverma3698/FounderOS" && r.piece === "workspace")?.detail).toContain("/founderos");
      expect(listed.find((r) => r.repo === "OplifyMessage/oplify-messaging-app" && r.piece === "workspace")?.detail).toContain("/oplify-messaging-app");
      expect(listed.find((r) => r.repo === "owner/founderos-tools" && r.piece === "workspace")?.detail).toContain("/founderos-tools");
      // and the daemon, given the same three repos, logs the same workspace paths
      fx.tick({ args: ["--dry-run"] });
      expect(fx.log()).toContain(`(workspace: ${fx.wsBase}/founderos)`);
      expect(fx.log()).toContain(`(workspace: ${fx.wsBase}/oplify-messaging-app)`);
      expect(fx.log()).toContain(`(workspace: ${fx.wsBase}/founderos-tools)`);
    } finally {
      fx.destroy();
    }
  });

  it("run twice: the second run changes NOTHING and exits 0 [idempotent]", () => {
    sb.setRepoLabels(REPO, []);
    const first = sb.onboard([REPO]);
    expect(first.status).toBe(0);

    const before = { review: snapshot(sb.reviewDir(REPO)), ws: snapshot(sb.workspaceDir(REPO)), labels: [...sb.repoLabels(REPO)] };
    sb.clearCallLogs();
    const second = sb.onboard([REPO]);

    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(labelCreates()).toEqual([]);
    expect(mutatingSudo()).toEqual([]);
    expect({ review: snapshot(sb.reviewDir(REPO)), ws: snapshot(sb.workspaceDir(REPO)), labels: [...sb.repoLabels(REPO)] }).toEqual(before);
    expect(second.stdout).toMatch(/ok\s+labels\s+8 of 8/);
  });

  it("creates only the labels that are missing, with --force", () => {
    sb.setRepoLabels(REPO, ["agent:ready", "agent:working", "agent:review", "agent:failed"]);
    sb.onboard([REPO]);

    expect(labelCreates()).toHaveLength(4);
    for (const missing of ["agent:blocked", "agent:needs-brief", "engine:agy", "engine:claude"]) {
      expect(labelCreates().join("\n")).toContain(missing);
    }
    for (const c of labelCreates()) expect(c).toContain("--force");
  });

  it("finds a label that is there however long the list is: grep stopping at its first hit is not 'absent'", () => {
    // `printf … | grep -q` under pipefail reads printf's SIGPIPE (status 141) as "no match" whenever grep quits on the
    // first hit before printf has finished writing. CI hit that once with eight labels on a loaded bash 5.2 box
    // (agent:failed "missing"); a list past the 64 KB pipe buffer makes it certain, so it is the deterministic stand-in.
    // The eight come first so that grep always has a hit in its first read.
    const filler = Array.from({ length: 3000 }, (_, i) => `filler-${i}-${"x".repeat(80)}`);
    sb.setRepoLabels(REPO, [...ALL_LABELS, ...filler]);
    const r = sb.onboard([REPO]);

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/ok\s+labels\s+8 of 8/);
    expect(labelCreates()).toEqual([]);
  });

  it("adopts a review checkout that is already there: updates it rather than re-cloning", () => {
    sb.ensureReviewCheckout(REPO);
    const before = snapshot(sb.reviewDir(REPO));
    sb.onboard([REPO]);

    expect(snapshot(sb.reviewDir(REPO))).toBe(before);
    expect(sb.sudoCalls().filter((c) => /\bgit clone\b/.test(c) && c.includes(sb.reviewDir(REPO)))).toEqual([]);
  });

  it("refuses to touch a directory that exists but is not a git checkout, and says so", () => {
    execFileSync("mkdir", ["-p", sb.reviewDir(REPO)]);
    writeFileSync(join(sb.reviewDir(REPO), "precious.txt"), "do not delete\n");
    const r = sb.onboard([REPO]);

    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/not a git checkout.*not touching it/s);
    expect(readFileSync(join(sb.reviewDir(REPO), "precious.txt"), "utf8")).toBe("do not delete\n");
  });

  it("does not report what it did not verify: a clone that silently produced nothing is a failure", () => {
    const r = sb.onboard([REPO], { stubs: { git: "exit 0" } });

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/MISSING\s+review checkout/);
    expect(r.stdout).not.toMatch(/ok\s+review checkout/);
  });

  it("if the labels cannot be verified it says UNKNOWN and exits non-zero, rather than printing a green tick", () => {
    sb.patchGh({ failLabelList: true });
    const r = sb.onboard([REPO]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNKNOWN\s+labels/);
    expect(r.stdout).not.toMatch(/ok\s+labels/);
  });
});

describe("onboard-repo.sh --check — report, change nothing", () => {
  it("prints every repo's missing pieces and exits 1, and touches nothing", () => {
    const two = new DispatchSandbox(["owner/alpha", "owner/beta"], { provision: false });
    try {
      two.ensureReviewCheckout("owner/alpha"); // alpha lacks only its workspace
      two.setRepoLabels("owner/beta", ["agent:ready"]); // beta lacks both checkouts and seven labels
      two.clearCallLogs();
      const r = two.onboard(["--check"]);

      expect(r.status).toBe(1);
      const listed = rows(two.onboard(["--check", "--porcelain"]).stdout);
      expect(listed.filter((x) => x.status === "MISSING").map((x) => `${x.repo} ${x.piece}`).sort()).toEqual(
        [
          "owner/alpha workspace",
          "owner/beta review",
          "owner/beta workspace",
          ...ALL_LABELS.filter((l) => l !== "agent:ready").map((l) => `owner/beta label:${l}`),
        ].sort(),
      );
      expect(r.stdout).toContain("owner/alpha");
      expect(r.stdout).toContain("owner/beta");
      expect(r.stdout).toMatch(/onboard-repo\.sh owner\/beta/);
      // nothing was created or changed
      expect(labelCreates()).toEqual([]);
      expect(mutatingSudo()).toEqual([]);
      expect(existsSync(two.workspaceDir("owner/alpha"))).toBe(false);
      expect(existsSync(two.reviewDir("owner/beta"))).toBe(false);
    } finally {
      two.destroy();
    }
  });

  it("with no arguments it checks the repos in the agent-dispatch next to it (the daemon's own list)", () => {
    const listed = rows(sb.onboard(["--check", "--porcelain"]).stdout);
    expect([...new Set(listed.map((x) => x.repo))]).toEqual([REPO]);
  });

  it("the real script, run beside the real deploy/agent-dispatch, checks exactly that file's DEFAULT_REPOS", () => {
    const declared = /^DEFAULT_REPOS=\((.*)\)$/m.exec(readFileSync(DAEMON, "utf8"))?.[1] ?? "";
    const expected = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(expected.length).toBeGreaterThanOrEqual(4);

    const r = spawnSync("bash", [SCRIPT, "--check", "--porcelain"], {
      env: {
        TG_QUIET_NOW: "12", // daytime: notify must not depend on when CI runs
        PATH: `${sb.stubs}:${sb.tools}`,
        HOME: sb.home,
        ONBOARD_REVIEW_BASE: sb.reviewBase,
        AGENT_DISPATCH_WORKSPACE_BASE: sb.wsBase,
        AGENT_DISPATCH_USER: userInfo().username,
        GH_STATE: join(sb.root, "gh-state.json"),
        GH_CALLS: join(sb.root, "gh-calls.log"),
        SUDO_ARGV: join(sb.root, "sudo-argv.log"),
      },
      encoding: "utf8",
    });
    expect([...new Set(rows(r.stdout).map((x) => x.repo))]).toEqual(expected);
  });

  it("is all green for a fully provisioned repo: exit 0, every row ok", () => {
    const green = new DispatchSandbox([REPO]);
    try {
      const human = green.onboard(["--check"]);
      expect(human.status, human.stdout).toBe(0);
      const listed = rows(green.onboard(["--check", "--porcelain"]).stdout);
      expect(listed.every((x) => x.status === "ok")).toBe(true);
      expect(listed.map((x) => x.piece).sort()).toEqual(["review", "workspace", ...ALL_LABELS.map((l) => `label:${l}`)].sort());
    } finally {
      green.destroy();
    }
  });

  it("marks a workspace owned by someone else MISSING, with who owns it and what was expected", () => {
    const green = new DispatchSandbox([REPO]);
    try {
      const listed = rows(green.onboard(["--check", "--porcelain"], { env: { AGENT_DISPATCH_USER: "someone-else" } }).stdout);
      const ws = listed.find((x) => x.piece === "workspace");
      expect(ws?.status).toBe("MISSING");
      expect(ws?.detail).toContain(`owned by ${userInfo().username}`);
      expect(ws?.detail).toContain("expected someone-else");
    } finally {
      green.destroy();
    }
  });

  it("a gh failure is UNKNOWN, not MISSING: the tooling being down must not read as a repo being broken", () => {
    const green = new DispatchSandbox([REPO]);
    try {
      green.patchGh({ failLabelList: true });
      const listed = rows(green.onboard(["--check", "--porcelain"]).stdout);
      expect(listed.filter((x) => x.status === "MISSING")).toEqual([]);
      expect(listed.find((x) => x.piece === "labels")?.status).toBe("UNKNOWN");
    } finally {
      green.destroy();
    }
  });

  it("flags a checkout whose origin is a different repository (WARN), naming it without any credentials", () => {
    const green = new DispatchSandbox([REPO]);
    try {
      const secret = "ghp_" + "S".repeat(36);
      execFileSync("git", ["-C", green.reviewDir(REPO), "remote", "set-url", "origin", `https://someone:${secret}@github.com/other/thing.git`]);
      const out = green.onboard(["--check"]);
      const listed = rows(green.onboard(["--check", "--porcelain"]).stdout);

      const review = listed.find((x) => x.piece === "review");
      expect(review?.status).toBe("WARN");
      expect(review?.detail).toContain("other/thing");
      expect(out.stdout + out.stderr).not.toContain(secret);
      expect(review?.detail).not.toContain(secret);
    } finally {
      green.destroy();
    }
  });
});

describe("onboard-repo.sh — secrets", () => {
  const TOKEN = "ghp_" + "T".repeat(36);

  it("never prints a token from the environment, on success or on failure", () => {
    const env = { GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, GH_ENTERPRISE_TOKEN: TOKEN };
    const ok = sb.onboard([REPO], { env });
    const failing = sb.onboard(["--check", REPO], { env, stubs: { gh: `echo "gh: bad credentials ${TOKEN}" >&2; exit 1` } });
    const bad = sb.onboard(["owner/bad name"], { env });

    for (const r of [ok, failing, bad]) expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("strips credentials out of any URL it has to print from a failed clone", () => {
    const leak = "ghp_" + "L".repeat(36);
    const r = sb.onboard([REPO], { stubs: { git: `echo "fatal: unable to access 'https://x-access-token:${leak}@github.com/owner/widgets.git/'" >&2; exit 128` } });

    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(leak);
    expect(r.stdout + r.stderr).toContain("https://github.com/owner/widgets.git");
  });

  it("clones from the plain https URL only: no credential is ever put on a command line", () => {
    sb.onboard([REPO]);

    for (const call of sb.sudoCalls()) expect(call).not.toMatch(/https:\/\/[^\s/]*@/);
    for (const call of sb.ghCallList()) expect(call).not.toMatch(/token/i);
  });

  it("the script never turns on shell tracing (set -x would print every command, and its environment)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/^\s*set\s+-[a-z]*x/m);
    expect(src).not.toMatch(/xtrace/);
  });
});

describe("the labels", () => {
  it("are exactly the agent:* labels the daemon uses, none invented and none left out", () => {
    const used = new Set(readFileSync(DAEMON, "utf8").match(/agent:[a-z]+(?:-[a-z]+)*/g) ?? []);
    expect([...used].sort()).toEqual([...AGENT_LABELS].sort());
    const declared = readFileSync(SCRIPT, "utf8").match(/agent:[a-z]+(?:-[a-z]+)*/g) ?? [];
    expect([...new Set(declared)].sort()).toEqual([...AGENT_LABELS].sort());
  });

  it("the engine:* labels the daemon's engine lib and this script use are the two the bot files under, and no others", () => {
    const ENGINE = fileURLToPath(new URL("../../../deploy/lib/engine.sh", import.meta.url));
    const found = (file: string): string[] => [...new Set(readFileSync(file, "utf8").match(/engine:[a-z]+/g) ?? [])].sort();
    expect(found(ENGINE)).toEqual([...ENGINE_LABELS].sort());
    expect(found(SCRIPT)).toEqual([...ENGINE_LABELS].sort());
  });
});
