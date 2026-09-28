/**
 * claude_code git guard — src/tools/claude-code-git-guard.ts.
 * ===========================================================
 * Product repos change only through a reviewed PR. These push real commits with
 * real git into local bare repositories that stand in for GitHub (a
 * `url.<bare>.insteadOf` rule maps the github.com URL onto them), with the hook
 * installed exactly the way claude_code installs it: through GIT_CONFIG_* env.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prePushHook,
  installGitGuard,
  gitGuardEnv,
  gitGuardDir,
  REPO_POLICY_DIRECTIVE,
} from "../../../src/tools/claude-code-git-guard.js";
import { withExecutionDirective, claudeCodeTool } from "../../../src/tools/claude-code.js";

const PRODUCT = "https://github.com/OplifyMessage/oplify-messaging-api.git";
const DEMO = "https://github.com/pushkarverma3698/some-demo.git";

let root: string;
let work: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = work) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

/** Bare repo standing in for `url`; returns its path. */
function fakeGithub(url: string, name: string): string {
  const bare = join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["config", `url.${bare}.insteadOf`, url], { cwd: work });
  return bare;
}

function branchesOf(bare: string): string {
  return execFileSync("git", ["--git-dir", bare, "branch", "--list"], { encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cc-guard-"));
  work = join(root, "work");
  mkdirSync(work);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: work,
  });
  // A stand-in for the real gh: records every call that reaches it.
  mkdirSync(join(root, "realbin"));
  writeFileSync(join(root, "realbin", "gh"), `#!/bin/sh\necho "$*" >> "${join(root, "gh-calls")}"\n`);
  chmodSync(join(root, "realbin", "gh"), 0o755);
  const hooks = installGitGuard(join(root, "hooks"), join(root, "realbin"));
  env = { ...process.env, ...gitGuardEnv(hooks, process.env) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git guard — product repos", () => {
  it.each(["main", "master", "beta", "development"])("refuses a push to %s", (branch) => {
    const bare = fakeGithub(PRODUCT, "api");
    git(["remote", "add", "origin", PRODUCT]);
    const r = git(["push", "origin", `HEAD:refs/heads/${branch}`]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`refused push to ${branch} on oplifymessage/oplify-messaging-api`);
    expect(r.stderr).toContain("DRAFT PR to beta");
    expect(branchesOf(bare)).not.toContain(branch);
  });

  it("allows a feature branch, which is how a PR starts", () => {
    const bare = fakeGithub(PRODUCT, "api");
    git(["remote", "add", "origin", PRODUCT]);
    const r = git(["push", "origin", "HEAD:refs/heads/fix/thing"]);
    expect(r.status).toBe(0);
    expect(branchesOf(bare)).toContain("fix/thing");
  });

  it("refuses a push straight to the URL, with no remote name", () => {
    const bare = fakeGithub(PRODUCT, "api");
    const r = git(["push", PRODUCT, "HEAD:refs/heads/main"]);
    expect(r.status).not.toBe(0);
    expect(branchesOf(bare)).not.toContain("main");
  });

  it("refuses when only the remote's pushurl names the product repo", () => {
    const bare = fakeGithub(PRODUCT, "api");
    git(["remote", "add", "origin", DEMO]);
    git(["config", "remote.origin.pushurl", PRODUCT]);
    const r = git(["push", "origin", "HEAD:refs/heads/main"]);
    expect(r.status).not.toBe(0);
    expect(branchesOf(bare)).not.toContain("main");
  });

  it("refuses deleting a protected branch", () => {
    const bare = fakeGithub(PRODUCT, "api");
    git(["remote", "add", "origin", PRODUCT]);
    // Seed beta WITHOUT the guard (plain process env), then try to delete it with it.
    execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/beta"], { cwd: work });
    expect(branchesOf(bare)).toContain("beta");
    const r = git(["push", "origin", ":refs/heads/beta"]);
    expect(r.status).not.toBe(0);
    expect(branchesOf(bare)).toContain("beta");
  });

  it("applies to a repo the run clones itself", () => {
    const bare = fakeGithub(PRODUCT, "api");
    git(["remote", "add", "origin", PRODUCT]);
    expect(git(["push", "-q", "origin", "HEAD:refs/heads/fix/seed"]).status).toBe(0);
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "-q", bare, clone], { env });
    execFileSync("git", ["remote", "set-url", "origin", PRODUCT], { cwd: clone });
    execFileSync("git", ["config", `url.${bare}.insteadOf`, PRODUCT], { cwd: clone });
    const r = git(["push", "origin", "HEAD:refs/heads/main"], clone);
    expect(r.status).not.toBe(0);
  });
});

describe("git guard — every other repo", () => {
  it("allows a new project to push its first commit to main", () => {
    const bare = fakeGithub(DEMO, "demo");
    git(["remote", "add", "origin", DEMO]);
    const r = git(["push", "origin", "HEAD:refs/heads/main"]);
    expect(r.status).toBe(0);
    expect(branchesOf(bare)).toContain("main");
  });
});

describe("git guard — URL shapes resolve to the same repo", () => {
  // Run the hook directly: $1 remote name, $2 URL, stdin = one ref line to main.
  const hookRun = (url: string) => {
    const hook = join(root, "hooks", "pre-push");
    return spawnSync(hook, ["origin", url], {
      cwd: work,
      input: "refs/heads/main aaaa refs/heads/main 0000\n",
      encoding: "utf8",
    });
  };

  it.each([
    "https://github.com/OplifyMessage/oplify-messaging-api.git",
    "https://x-access-token:ghp_abc123@github.com/OplifyMessage/oplify-messaging-api.git",
    "git@github.com:OplifyMessage/oplify-messaging-api.git",
    "ssh://git@github.com/OplifyMessage/oplify-messaging-api",
    "https://github.com/oplifymessage/OPLIFY-MESSAGING-API/",
    "https://github.com/pushkarverma3698/FounderOS",
    "https://github.com/pushkarverma3698/House-of-Hulda-Website-frontend.git",
    "https://github.com/OplifyMessage/oplify-messaging-app.git",
    // Shapes that slipped through before the security review of #747:
    "https://github.com/OplifyMessage/oplify-messaging-api.git/",
    "https://www.github.com/OplifyMessage/oplify-messaging-api.git",
    "https://github.com:443/OplifyMessage/oplify-messaging-api.git",
    "HTTPS://GITHUB.COM/OplifyMessage/oplify-messaging-api.git",
  ])("%s is protected", (url) => {
    expect(hookRun(url).status).toBe(1);
  });

  it.each([
    "https://github.com/OplifyMessage/oplify-messaging-api-fork.git",
    "https://github.com/someone/oplify-messaging-api.git",
  ])("%s is not", (url) => {
    expect(hookRun(url).status).toBe(0);
  });
});

describe("git guard — wiring", () => {
  it("appends after GIT_CONFIG entries the environment already has", () => {
    expect(gitGuardEnv("/h", { GIT_CONFIG_COUNT: "2", PATH: "/usr/bin" })).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/h",
      PATH: "/h/bin:/usr/bin",
    });
  });

  it("puts the repo policy in every brief, once", () => {
    const once = withExecutionDirective("build a thing");
    expect(once).toContain(REPO_POLICY_DIRECTIVE);
    expect(withExecutionDirective(once)).toBe(once);
  });

  it("bakes the repo list into the hook, so losing an env var loses nothing", () => {
    expect(prePushHook(["A/B"])).toContain('PROTECTED_REPOS="a/b"');
  });
});

describe("claude_code — every run carries the guard", () => {
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env["HOME"];
    process.env["HOME"] = join(root, "home");
    mkdirSync(join(root, "home"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = savedHome;
  });

  it("spawns the CLI with core.hooksPath pointing at an executable pre-push hook", async () => {
    const res = await claudeCodeTool.execute({ task: "t", _binaryOverride: "/usr/bin/env" });
    expect(res.success).toBe(true);
    const out = String(res.data);
    const dir = gitGuardDir(join(root, "home"));
    expect(out).toContain("GIT_CONFIG_KEY_0=core.hooksPath");
    expect(out).toContain(`GIT_CONFIG_VALUE_0=${dir}`);
    expect(statSync(join(dir, "pre-push")).mode & 0o111).not.toBe(0);
  });

  it("appends to GIT_CONFIG entries already in the service's env and puts the gh wrapper first on PATH", async () => {
    const saved = { c: process.env["GIT_CONFIG_COUNT"], k: process.env["GIT_CONFIG_KEY_0"], v: process.env["GIT_CONFIG_VALUE_0"] };
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "user.name";
    process.env["GIT_CONFIG_VALUE_0"] = "founderos";
    try {
      const res = await claudeCodeTool.execute({ task: "t", _binaryOverride: "/usr/bin/env" });
      const out = String(res.data);
      const dir = gitGuardDir(join(root, "home"));
      expect(out).toContain("GIT_CONFIG_COUNT=2");
      expect(out).toContain("GIT_CONFIG_KEY_0=user.name");
      expect(out).toContain("GIT_CONFIG_KEY_1=core.hooksPath");
      expect(out).toMatch(new RegExp(`^PATH=${dir}/bin:`, "m"));
    } finally {
      for (const [k, v] of [["GIT_CONFIG_COUNT", saved.c], ["GIT_CONFIG_KEY_0", saved.k], ["GIT_CONFIG_VALUE_0", saved.v]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("fails closed: no guard, no run", async () => {
    // A FILE where the hooks directory must go makes the install fail.
    mkdirSync(join(root, "home", ".cache", "founderos"), { recursive: true });
    writeFileSync(gitGuardDir(join(root, "home")), "not a directory");
    // /usr/bin/env would succeed and print the environment if it were spawned.
    const res = await claudeCodeTool.execute({ task: "t", _binaryOverride: "/usr/bin/env" });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("could not install the git guard");
    expect(String(res.data ?? "")).not.toContain("PATH=");
  });
});

describe("gh wrapper — gh cannot go around the hook", () => {
  const ghCalls = () => (existsSync(join(root, "gh-calls")) ? readFileSync(join(root, "gh-calls"), "utf8") : "");
  const gh = (args: string[], cwd = work) =>
    spawnSync(join(root, "hooks", "bin", "gh"), args, { cwd, encoding: "utf8" });

  it.each([
    [["pr", "merge", "12", "--squash"], "cwd origin"],
    [["pr", "merge", "12", "-R", "OplifyMessage/oplify-messaging-api"], "-R"],
    [["pr", "merge", "12", "--repo=oplifymessage/OPLIFY-MESSAGING-API"], "--repo="],
    [["pr", "merge", "https://github.com/OplifyMessage/oplify-messaging-api/pull/3"], "PR URL"],
    [["repo", "delete", "OplifyMessage/oplify-messaging-api", "--yes"], "positional repo"],
    [["api", "repos/OplifyMessage/oplify-messaging-api/contents/a.txt", "-X", "PUT", "-f", "message=m"], "api -X PUT"],
    [["api", "-XDELETE", "/repos/OplifyMessage/oplify-messaging-api/git/refs/heads/beta"], "api -XDELETE"],
    [["api", "--method=PATCH", "repos/OplifyMessage/oplify-messaging-api"], "api --method="],
    [["api", "repos/OplifyMessage/oplify-messaging-api/merges", "-f", "base=main", "-f", "head=x"], "api implicit POST"],
    [["api", "graphql", "-f", "query=mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }"], "graphql mutation"],
  ])("refuses %j (%s) and never reaches the real gh", (args) => {
    git(["remote", "add", "origin", PRODUCT]);
    const r = gh(args as string[]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refused");
    expect(ghCalls()).toBe("");
  });

  it.each([
    [["pr", "create", "--draft", "--base", "beta", "--title", "t", "--body", "b"], PRODUCT],
    [["api", "repos/OplifyMessage/oplify-messaging-api/pulls"], PRODUCT],
    [["api", "graphql", "-f", "query={ viewer { login } }"], PRODUCT],
    [["pr", "merge", "12"], DEMO],
    [["repo", "delete", "pushkarverma3698/some-demo", "--yes"], DEMO],
    [["pr", "merge", "12", "-R", "pushkarverma3698/some-demo"], PRODUCT],
  ])("passes %j through to the real gh", (args, origin) => {
    git(["remote", "add", "origin", origin as string]);
    const r = gh(args as string[]);
    expect(r.status).toBe(0);
    expect(ghCalls().trim()).toBe((args as string[]).join(" "));
  });

  it("is not installed when there is no real gh to wrap", () => {
    const dir = installGitGuard(join(root, "nogh"), join(root, "empty-path"));
    expect(existsSync(join(dir, "bin", "gh"))).toBe(false);
  });
});

describe("git guard — install is atomic and idempotent", () => {
  it("leaves the files untouched when nothing changed, and no temp files behind", () => {
    const dir = join(root, "hooks");
    const before = statSync(join(dir, "pre-push")).mtimeMs;
    installGitGuard(dir, join(root, "realbin"));
    expect(statSync(join(dir, "pre-push")).mtimeMs).toBe(before);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(join(dir, "bin")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces a stale hook with the current one", () => {
    const dir = join(root, "hooks");
    writeFileSync(join(dir, "pre-push"), "#!/bin/sh\nexit 0\n");
    installGitGuard(dir, join(root, "realbin"));
    expect(readFileSync(join(dir, "pre-push"), "utf8")).toBe(prePushHook());
  });
});
