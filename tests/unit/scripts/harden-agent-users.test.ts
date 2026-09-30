/**
 * harden-agent-users — deploy/harden-agent-users.sh
 * ==================================================
 * Until 2026-09-30 the builder (`antigravity`, run with --dangerously-skip-permissions on employer
 * code) held the founder's full-scope GitHub token, the production Telegram bot token (in its brain-MCP
 * env file), and could read the CV directory and a `.env` with payment/cloud secrets; Claude ran as a
 * user with passwordless sudo. The script makes the
 * agents unable to push, sudo or read prod secrets, and `--check` is the standing proof.
 *
 * These run the real script against a scratch tree with fake `sudo`, `id`, `useradd`, `passwd`,
 * `visudo` and `gh`. Real git runs against the fake homes, so the push-URL rewriting under test is
 * git's own. The fake `sudo` scrubs the environment like sudo's env_reset, switches HOME, and
 * answers `test -r` from the file's "others" permission bits: as another user, that is the only
 * thing that decides whether the file is readable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = process.env["HARDEN_SCRIPT_UNDER_TEST"] ?? fileURLToPath(new URL("../../../deploy/harden-agent-users.sh", import.meta.url));
const RULE = "founderos ALL=(claude-agent) NOPASSWD: /usr/bin/claude";
const PUSH_BASE = "https://push-disabled.invalid/";

let root: string;
let bin: string;
let homes: string;
let sudoersDir: string;
let dataDir: string;
let reviewDir: string;
let envFile: string;
let usersFile: string;
let stateDir: string;
let callsLog: string;
let sudoListFile: string;

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[], extra: Record<string, string> = {}, skipRootCheck = true) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(root, "root-home"),
      ...(skipRootCheck ? { HARDEN_SKIP_ROOT_CHECK: "1" } : {}),
      HARDEN_HOMES: homes,
      HARDEN_SUDOERS_DIR: sudoersDir,
      HARDEN_SUDOERS_OWNER: String(userInfo().uid),
      HARDEN_SUDOERS_GROUP: String(userInfo().gid),
      HARDEN_ENV_FILE: envFile,
      HARDEN_DATA_DIR: dataDir,
      HARDEN_REVIEW_DIR: reviewDir,
      FAKE_HOMES: homes,
      FAKE_USERS: usersFile,
      FAKE_STATE: stateDir,
      FAKE_CALLS: callsLog,
      FAKE_SUDO_L: sudoListFile,
      ...extra,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
}

const calls = () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8").split("\n").filter(Boolean) : []);
const gitconfig = (user: string) => readFileSync(join(homes, user, ".gitconfig"), "utf8");
const mode = (p: string) => statSync(p).mode & 0o777;
const hubEnv = () => join(homes, "antigravity", ".config", "founderos-hub.env");

/** The state of the box on 2026-09-30, before hardening. */
function seedBefore(): void {
  writeFileSync(usersFile, "founderos\nantigravity\n");
  mkdirSync(join(homes, "antigravity", ".config", "gh"), { recursive: true });
  writeFileSync(join(homes, "antigravity", ".config", "gh", "hosts.yml"), "github.com:\n    oauth_token: not-a-real-token\n");
  writeFileSync(
    join(homes, "antigravity", ".gitconfig"),
    [
      "[user]",
      "\tname = FounderOS Antigravity",
      '[credential "https://github.com"]',
      "\thelper = ",
      "\thelper = !/usr/local/bin/gh auth git-credential",
      '[credential "https://gist.github.com"]',
      "\thelper = ",
      "\thelper = !/usr/local/bin/gh auth git-credential",
      "",
    ].join("\n"),
  );
  writeFileSync(
    hubEnv(),
    [
      "DATABASE_URL=postgres://brain_agent:fake-pw@127.0.0.1:5432/founderos",
      "TELEGRAM_BOT_TOKEN=123456:fake-bot-token-value",
      "TELEGRAM_CHAT_ID=42",
      "HUB_SCOPE=brain",
      "",
    ].join("\n"),
  );
  chmodSync(hubEnv(), 0o640); // not the mktemp default (0600): a rewrite that swaps the file for a temp copy would show
  mkdirSync(join(dataDir, "cv"), { recursive: true });
  chmodSync(dataDir, 0o755);
  mkdirSync(join(reviewDir, "oplify-messaging-api"), { recursive: true });
  const dotenv = join(reviewDir, "oplify-messaging-api", ".env");
  writeFileSync(dotenv, "RAZORPAY_KEY_SECRET=not-a-real-secret\n");
  chmodSync(dotenv, 0o664);
}

/** Harden the seeded box and prove it is clean, so a test can flip ONE property and see exactly that ✗. */
function hardenedAndClean(): void {
  seedBefore();
  run(["--apply"]);
  expect(run(["--check"]).status).toBe(0);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harden-"));
  bin = join(root, "bin");
  homes = join(root, "homes");
  sudoersDir = join(root, "sudoers.d");
  dataDir = join(root, "opt", "founderos-data");
  reviewDir = join(root, "opt", "review");
  envFile = join(root, "opt", "founderos", ".env"); // absent unless a test creates it
  usersFile = join(root, "users");
  stateDir = join(root, "state");
  callsLog = join(root, "calls.log");
  sudoListFile = join(root, "sudo-l.txt");
  for (const d of [bin, homes, sudoersDir, stateDir, join(root, "root-home")]) mkdirSync(d, { recursive: true });
  writeFileSync(sudoListFile, "User claude-agent is not allowed to run sudo on this-host.\n");

  // sudo as another user: scrubbed env, that user's HOME, no system gitconfig unless a test supplies one (so the host's own,
  // e.g. Apple git's osxkeychain helper, cannot leak in), and `test -r` decided by the "others" bits.
  stub(
    "sudo",
    `user=""; list=0
while [ $# -gt 0 ]; do case "$1" in
  -n|-H) shift ;; -u) user="$2"; shift 2 ;; -l) list=1; shift ;; -U) shift 2 ;; --) shift; break ;; *) break ;;
esac; done
if [ "$list" = 1 ]; then cat "$FAKE_SUDO_L"; exit 0; fi
if [ "$1" = test ] && [ "$2" = -r ]; then
  m=$(stat -c %a "$3" 2>/dev/null || stat -f %Lp "$3" 2>/dev/null) || exit 1
  [ $(( 8#\${m: -1} & 4 )) -ne 0 ]; exit $?
fi
if [ -n "$FAKE_GIT_SYSTEM" ]; then sys="GIT_CONFIG_SYSTEM=$FAKE_GIT_SYSTEM"; else sys="GIT_CONFIG_NOSYSTEM=1"; fi
exec env -i HOME="$FAKE_HOMES/$user" PATH="$PATH" "$sys" "$@"`,
  );
  stub(
    "id",
    `case "$1" in
  -u) exec /usr/bin/id -u ;;
  -nG) if [ "$2" = claude-agent ]; then echo "\${FAKE_CA_GROUPS:-claude-agent}"; else echo "$2"; fi ;;
  *) grep -qx -- "$1" "$FAKE_USERS" ;;
esac`,
  );
  stub(
    "useradd",
    `home=""; name=""
while [ $# -gt 0 ]; do case "$1" in
  --home-dir) home="$2"; shift 2 ;; --shell|--comment) shift 2 ;; --create-home) shift ;; *) name="$1"; shift ;;
esac; done
mkdir -p "$home"; echo "$name" >>"$FAKE_USERS"; echo "useradd $name" >>"$FAKE_CALLS"`,
  );
  stub(
    "passwd",
    `case "$1" in
  -l) touch "$FAKE_STATE/locked-$2" ;;
  -S) if [ -e "$FAKE_STATE/locked-$2" ]; then echo "$2 L 09/30/2026 0 99999 7 -1"; else echo "$2 P 09/30/2026 0 99999 7 -1"; fi ;;
esac`,
  );
  stub(
    "visudo",
    `[ "$FAKE_VISUDO_FAIL" = 1 ] && exit 1
grep -qE '^[a-z_-]+ ALL=\\([a-z-]+\\) NOPASSWD: /[^ ]+$' "$2"`,
  );
  stub("gh", `[ "$1 $2" = "auth status" ] && grep -qs oauth_token "$HOME/.config/gh/hosts.yml"`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("harden-agent-users --check", () => {
  it("reports every gap on the box as it was, and exits 1", () => {
    seedBefore();

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ account exists/);
    // Nothing below "account exists" means anything for an account that is not there, so nothing is printed.
    expect(r.stdout).toMatch(/\[claude-agent\]\n {2}✗ account exists\n\[claude-agent: account\]\n\[sudoers\]/);
    expect(r.stdout).toMatch(/✗ gh holds no GitHub login/);
    expect(r.stdout).toMatch(/✗ no git credential helper configured/);
    expect(r.stdout).toMatch(/✗ stored credentials on disk: \.config\/gh\/hosts\.yml/);
    expect(r.stdout).toMatch(/✗ git push to https:\/\/github\.com\/… would reach GitHub/);
    expect(r.stdout).toMatch(/✗ no Telegram bot token in its env files — found:\n\s+.*founderos-hub\.env/);
    expect(r.stdout).not.toContain("fake-bot-token-value");
    expect(r.stdout).toMatch(/✗ cannot read .*founderos-data/);
    expect(r.stdout).toMatch(/✗ .*founderos-data is open to others/);
    expect(r.stdout).toMatch(/✗ no world-readable \.env under/);
    expect(r.stdout).toMatch(/✗ .*claude-agent is missing/);
    expect(r.stdout).toMatch(/CHECK\(S\) FAILED/);
  });

  it("never changes anything", () => {
    seedBefore();
    const before = { git: gitconfig("antigravity"), dataMode: mode(dataDir), users: readFileSync(usersFile, "utf8") };

    run(["--check"]);

    expect(existsSync(join(homes, "antigravity", ".config", "gh", "hosts.yml"))).toBe(true);
    expect(gitconfig("antigravity")).toBe(before.git);
    expect(mode(dataDir)).toBe(before.dataMode);
    expect(readFileSync(usersFile, "utf8")).toBe(before.users);
    expect(existsSync(join(sudoersDir, "claude-agent"))).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("flags every GitHub token variable exported in a login profile, by name and never by value", () => {
    hardenedAndClean();
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN"];
    writeFileSync(join(homes, "antigravity", ".profile"), names.map((n) => `export ${n}=sekrit-value-of-${n}\n`).join(""));

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ no GitHub token in the login environment — found:\n/);
    for (const n of names) {
      expect(r.stdout).toMatch(new RegExp(`^ {6}${n}$`, "m"));
      expect(r.stdout).not.toContain(`sekrit-value-of-${n}`);
    }
  });

  it("flags every place a GitHub credential can be stored, by file name", () => {
    hardenedAndClean();
    const h = join(homes, "antigravity");
    mkdirSync(join(h, ".config", "gh"), { recursive: true });
    mkdirSync(join(h, ".config", "git"), { recursive: true });
    writeFileSync(join(h, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: not-real\n");
    writeFileSync(join(h, ".git-credentials"), "https://x:not-real@github.com\n");
    writeFileSync(join(h, ".config", "git", "credentials"), "https://x:not-real@github.com\n");
    writeFileSync(join(h, ".netrc"), "machine github.com login x password not-real\n");

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("✗ stored credentials on disk: .config/gh/hosts.yml .git-credentials .config/git/credentials .netrc");
    expect(r.stdout).not.toContain("not-real");
  });

  it("flags a credential helper configured system-wide, not only in the user's own gitconfig", () => {
    hardenedAndClean();
    const system = join(root, "etc-gitconfig");
    writeFileSync(system, "[credential]\n\thelper = store\n");

    const r = run(["--check"], { FAKE_GIT_SYSTEM: system });

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ no git credential helper configured — found:[\s\S]*?credential\.helper store/);
  });

  it("flags a claude-agent that can sudo or sits in any privileged group", () => {
    hardenedAndClean();
    writeFileSync(sudoListFile, "User claude-agent may run the following commands on this-host:\n    (ALL) NOPASSWD: ALL\n");
    const groups = ["sudo", "admin", "wheel", "docker", "adm", "root", "lxd", "disk", "shadow", "founderos"];

    const r = run(["--check"], { FAKE_CA_GROUPS: ["claude-agent", ...groups].join(" ") });

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ sudo -l says it may run nothing/);
    const line = r.stdout.split("\n").find((l) => l.includes("member of privileged group(s)")) ?? "";
    expect(line).toMatch(/^ {2}✗ /);
    for (const g of groups) expect(line).toMatch(new RegExp(`[ :]${g}( |$)`));
    expect(line).not.toContain("claude-agent");
  });

  it("flags a claude-agent whose password is not locked or whose home is open to others", () => {
    hardenedAndClean();
    rmSync(join(stateDir, "locked-claude-agent"));
    chmodSync(join(homes, "claude-agent"), 0o755);

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ password is not locked/);
    expect(r.stdout).toMatch(/✗ home is not 0700 \(is 755\)/);
  });

  it("flags a prod .env that the agents could read", () => {
    hardenedAndClean();
    mkdirSync(join(root, "opt", "founderos"), { recursive: true });
    writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=not-a-real-token\n");
    chmodSync(envFile, 0o664);

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ cannot read .*\.env/);
  });

  it("flags a rule riding along in the sudoers file", () => {
    hardenedAndClean();
    const file = join(sudoersDir, "claude-agent");
    chmodSync(file, 0o640); // root can edit a 0440 file; the test user cannot
    appendFileSync(file, "founderos ALL=(ALL) NOPASSWD: ALL\n");
    chmodSync(file, 0o440); // so the "other rules" check is the only thing that flips

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ contains other rules/);
  });

  it("flags a database URL for any role but the brain role, and every kind of secret variable, by name only", () => {
    hardenedAndClean();
    const secretVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "RAZORPAY_KEY_SECRET",
      "STRIPE_SECRET_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ];
    writeFileSync(
      join(homes, "antigravity", ".config", "app.env"),
      ["DATABASE_URL=postgres://founderos:super-secret-pw@127.0.0.1/founderos", ...secretVars.map((v) => `${v}=value-of-${v}`), ""].join("\n"),
    );
    // A role that merely starts with the brain role's name is another role.
    writeFileSync(join(homes, "antigravity", ".config", "role.env"), "DATABASE_URL=postgres://brain_agent_admin:pw2@127.0.0.1/founderos\n");

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ no other secret or database role in its env files — found:\n[\s\S]*?app\.env \(DATABASE_URL for a role other than brain_agent\)/);
    expect(r.stdout).toMatch(/role\.env \(DATABASE_URL for a role other than brain_agent\)/);
    const holds = r.stdout.split("\n").find((l) => l.includes("app.env (holds a secret variable:")) ?? "";
    for (const v of secretVars) expect(holds).toMatch(new RegExp(`[ :]${v}( |\\))`));
    expect(r.stdout).not.toContain("super-secret-pw");
    expect(r.stdout).not.toContain("pw2");
    expect(r.stdout).not.toContain("value-of-");
  });

  it("passes on a home that holds only harmless files: public keys, an ssh config, caches, empty secret values", () => {
    hardenedAndClean();
    const h = join(homes, "antigravity");
    mkdirSync(join(h, ".ssh"), { recursive: true });
    for (const f of ["known_hosts", "known_hosts.old", "id_ed25519.pub", "authorized_keys", "config"]) writeFileSync(join(h, ".ssh", f), "x\n");
    // Caches and package stores carry token-shaped fixtures; they are not where an agent keeps a secret.
    for (const d of [".cache/pkg", ".npm/_cacache", ".local/share", "node_modules/pkg"]) {
      mkdirSync(join(h, d), { recursive: true });
      writeFileSync(
        join(h, d, "fixture.env"),
        "TELEGRAM_BOT_TOKEN=123456:not-a-real-token\nANTHROPIC_API_KEY=sk-not-real\nDATABASE_URL=postgres://founderos:pw@127.0.0.1/x\n",
      );
    }
    // A variable that is named but empty holds no secret.
    writeFileSync(join(h, ".config", "empty.env"), "ANTHROPIC_API_KEY=\nGH_TOKEN=\n");

    const r = run(["--check"]);

    expect(r.stdout).toMatch(/ALL CHECKS PASSED/);
    expect(r.status).toBe(0);
  });

  it("flags an SSH key however it is named", () => {
    hardenedAndClean();
    mkdirSync(join(homes, "antigravity", ".ssh"), { recursive: true });
    writeFileSync(join(homes, "antigravity", ".ssh", "deploy_key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-real\n");
    writeFileSync(join(homes, "antigravity", ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n");

    const r = run(["--check"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ no SSH private key — found:\n\s+.*deploy_key/);
    expect(r.stdout).not.toMatch(/known_hosts/);
  });

  it("lists every finding on its own line, up to ten, and counts the rest instead of hiding them", () => {
    hardenedAndClean();
    const ssh = join(homes, "antigravity", ".ssh");
    mkdirSync(ssh, { recursive: true });
    const addKey = (i: number) => writeFileSync(join(ssh, `key${String(i).padStart(2, "0")}`), "k\n");
    const shown = (out: string) => (out.match(/^ {6}\S*\.ssh\/key\d\d$/gm) ?? []).length;

    for (let i = 1; i <= 10; i++) addKey(i);
    let out = run(["--check"]).stdout;
    expect(shown(out)).toBe(10);
    expect(out).not.toMatch(/… and \d+ more/);

    addKey(11);
    out = run(["--check"]).stdout;
    expect(shown(out)).toBe(10);
    expect(out).toMatch(/^ {6}… and 1 more$/m);

    addKey(12);
    expect(run(["--check"]).stdout).toMatch(/^ {6}… and 2 more$/m);
  });

  it("flags a sudoers file with the wrong rule, a loose mode, or that visudo rejects", () => {
    hardenedAndClean();
    const file = join(sudoersDir, "claude-agent");
    chmodSync(file, 0o640);
    writeFileSync(file, "founderos ALL=(claude-agent) NOPASSWD: /usr/bin/bash\n");
    chmodSync(file, 0o644);

    const r = run(["--check"], { FAKE_VISUDO_FAIL: "1" });

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ does not contain the expected rule/);
    expect(r.stdout).toMatch(/✗ mode is 644, not 0440/);
    expect(r.stdout).toMatch(/✗ passes visudo -c/);
    expect(r.stdout).toMatch(/✓ contains no other rule/);
  });

  it("treats any access for others on the CV directory as open, and 0750 as closed", () => {
    hardenedAndClean();

    for (const others of [1, 2, 3, 4, 5, 6, 7]) {
      chmodSync(dataDir, 0o750 | others);
      expect(run(["--check"]).stdout, `mode 075${others}`).toMatch(new RegExp(`✗ .*founderos-data is open to others \\(mode 75${others}\\)`));
    }
    chmodSync(dataDir, 0o750);
    expect(run(["--check"]).status).toBe(0);
  });

  it("prints its header for --help without needing root, and changes nothing", () => {
    seedBefore();

    const r = run(["--help"], {}, false);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^harden-agent-users — take GitHub write access, sudo and prod secrets away/m);
    expect(r.stdout).toMatch(/--apply/);
    expect(r.stdout).not.toMatch(/^usage:/m);
    expect(existsSync(join(homes, "antigravity", ".config", "gh", "hosts.yml"))).toBe(true);
    expect(calls()).toEqual([]);
  });

  it("rejects an unknown argument, and needs root unless told it is being tested", () => {
    expect(run(["--nope"]).status).toBe(2);
    expect(run([]).status).toBe(2);
    if (process.getuid?.() !== 0) {
      const r = run(["--check"], {}, false);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/must run as root/);
    }
  });
});

describe("harden-agent-users --apply", () => {
  it("removes the GitHub login, disables pushes, creates claude-agent, and --check then passes", () => {
    seedBefore();

    const r = run(["--apply"]);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ALL CHECKS PASSED/);
    expect(existsSync(join(homes, "antigravity", ".config", "gh", "hosts.yml"))).toBe(false);
    expect(gitconfig("antigravity")).not.toMatch(/credential/);
    for (const user of ["antigravity", "claude-agent"]) {
      expect(gitconfig(user)).toContain(`[url "${PUSH_BASE}"]`);
      expect(gitconfig(user).match(/pushInsteadOf/gi)).toHaveLength(3);
    }
    expect(calls()).toEqual(["useradd claude-agent"]);
    expect(mode(join(homes, "claude-agent"))).toBe(0o700);
    expect(existsSync(join(stateDir, "locked-claude-agent"))).toBe(true);
  });

  it("replaces the Telegram bot token with a placeholder and touches nothing else in the file", () => {
    seedBefore();

    const r = run(["--apply"]);

    const env = readFileSync(hubEnv(), "utf8");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=placeholder-unused");
    expect(env).toContain("TELEGRAM_CHAT_ID=0");
    expect(env).not.toContain("fake-bot-token-value");
    // The brain MCP's own settings survive: its DB role and scope are deliberate.
    expect(env).toContain("DATABASE_URL=postgres://brain_agent:fake-pw@127.0.0.1:5432/founderos");
    expect(env).toContain("HUB_SCOPE=brain");
    expect(mode(hubEnv())).toBe(0o640);
    expect(r.stdout).not.toContain("fake-bot-token-value");
    expect(r.stdout).toMatch(/ALL CHECKS PASSED/);
  });

  it("does not rewrite an env file that carries a different database role or another secret", () => {
    seedBefore();
    const other = join(homes, "antigravity", ".config", "app.env");
    const body = "DATABASE_URL=postgres://founderos:pw@127.0.0.1/x\nANTHROPIC_API_KEY=sk-not-real\n";
    writeFileSync(other, body);

    const r = run(["--apply"]);

    expect(readFileSync(other, "utf8")).toBe(body);
    expect(r.stdout).not.toMatch(/replaced with a placeholder in .*app\.env/);
    expect(r.status).toBe(1);
  });

  it("removes every stored GitHub credential, and an unscoped git credential section too", () => {
    seedBefore();
    const h = join(homes, "antigravity");
    mkdirSync(join(h, ".config", "git"), { recursive: true });
    writeFileSync(join(h, ".git-credentials"), "https://x:not-real@github.com\n");
    writeFileSync(join(h, ".config", "git", "credentials"), "https://x:not-real@github.com\n");
    writeFileSync(join(h, ".netrc"), "machine github.com login x password not-real\n");
    appendFileSync(join(h, ".gitconfig"), "[credential]\n\thelper = store\n\tuseHttpPath = true\n");

    const r = run(["--apply"]);

    for (const f of [".git-credentials", ".netrc", ".config/git/credentials", ".config/gh/hosts.yml"]) {
      expect(existsSync(join(h, f))).toBe(false);
    }
    expect(gitconfig("antigravity")).not.toMatch(/credential/);
    expect(r.stdout).toMatch(/ALL CHECKS PASSED/);
    expect(r.status).toBe(0);
  });

  it("closes every .env variant in a review checkout, however deep, and leaves other files alone", () => {
    seedBefore();
    const closed = [
      join(reviewDir, "oplify-messaging-app", ".env.local"),
      join(reviewDir, "oplify-messaging-app", ".env.production"),
      join(reviewDir, "oplify-messaging-app", ".env.staging"),
      join(reviewDir, "oplify-messaging-api", "packages", "api", ".env"),
    ];
    const untouched = [
      join(reviewDir, "oplify-messaging-api", ".env.example"),
      join(reviewDir, "oplify-messaging-api", "node_modules", "pkg", ".env"),
    ];
    for (const f of [...closed, ...untouched]) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, "K=v\n");
      chmodSync(f, 0o664);
    }

    const before = run(["--check"]);
    run(["--apply"]);

    for (const f of closed) {
      expect(before.stdout).toContain(f);
      expect(mode(f) & 0o007).toBe(0);
      expect(mode(f) & 0o660).toBe(0o660);
    }
    for (const f of untouched) {
      expect(before.stdout).not.toContain(f);
      expect(mode(f)).toBe(0o664);
    }
    expect(run(["--check"]).status).toBe(0);
  });

  it("closes the CV directory and the world-readable .env to others, and leaves the owner's access alone", () => {
    seedBefore();

    run(["--apply"]);

    expect(mode(dataDir) & 0o007).toBe(0);
    expect(mode(dataDir) & 0o700).toBe(0o700);
    const dotenv = join(reviewDir, "oplify-messaging-api", ".env");
    expect(mode(dotenv) & 0o007).toBe(0);
    expect(mode(dotenv) & 0o600).toBe(0o600);
  });

  it("installs exactly one sudoers rule, mode 0440: the orchestrator may run claude as claude-agent, nothing else", () => {
    seedBefore();

    run(["--apply"]);

    const file = join(sudoersDir, "claude-agent");
    const rules = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(rules).toEqual([RULE]);
    expect(mode(file)).toBe(0o440);
  });

  it("is idempotent: a second run changes nothing", () => {
    seedBefore();
    run(["--apply"]);
    const first = { git: gitconfig("antigravity"), agent: gitconfig("claude-agent") };

    const r = run(["--apply"]);

    expect(r.status).toBe(0);
    expect(gitconfig("antigravity")).toBe(first.git);
    expect(gitconfig("claude-agent")).toBe(first.agent);
    expect(gitconfig("antigravity").match(/pushInsteadOf/gi)).toHaveLength(3);
    expect(calls()).toEqual(["useradd claude-agent"]);
  });

  it("refuses to install a sudoers rule that visudo rejects, and installs nothing", () => {
    seedBefore();

    const r = run(["--apply"], { FAKE_VISUDO_FAIL: "1" });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED/);
    expect(existsSync(join(sudoersDir, "claude-agent"))).toBe(false);
    // The sudoers rule is the least important step, so refusing it must not cost the rest.
    expect(existsSync(join(homes, "antigravity", ".config", "gh", "hosts.yml"))).toBe(false);
    expect(readFileSync(hubEnv(), "utf8")).not.toContain("fake-bot-token-value");
    expect(r.stdout).toMatch(/✗ .*claude-agent is missing/);
  });

  it("does not delete an SSH private key, but --check flags it for a human", () => {
    seedBefore();
    mkdirSync(join(homes, "antigravity", ".ssh"), { recursive: true });
    const key = join(homes, "antigravity", ".ssh", "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n");

    const r = run(["--apply"]);

    expect(existsSync(key)).toBe(true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ no SSH private key — found:\n\s+.*id_ed25519/);
  });

  it("disables pushes for every GitHub URL form, and leaves fetching alone", () => {
    seedBefore();
    run(["--apply"]);
    const repo = join(root, "scratch-repo");
    const env = { ...process.env, HOME: join(homes, "antigravity"), GIT_CONFIG_NOSYSTEM: "1" };
    spawnSync("git", ["init", "-q", repo], { env });

    for (const url of ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git"]) {
      spawnSync("git", ["-C", repo, "remote", "remove", "origin"], { env });
      spawnSync("git", ["-C", repo, "remote", "add", "origin", url], { env });
      const push = spawnSync("git", ["-C", repo, "remote", "get-url", "--push", "origin"], { env, encoding: "utf8" });
      const fetch = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { env, encoding: "utf8" });

      expect(push.stdout.trim().startsWith(PUSH_BASE)).toBe(true);
      expect(fetch.stdout.trim()).toBe(url);
    }
  });
});
