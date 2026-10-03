/**
 * A throwaway VPS for the agent-dispatch tests.
 *
 * It lays the daemon out the way deploy/sync-daemons.sh does on the box
 * (~/bin/agent-dispatch, ~/bin/onboard-repo.sh, ~/bin/lib/*.sh), so every test also
 * proves the script finds its sourced helpers from its own real path. Everything the
 * daemon talks to is a stand-in on a hermetic PATH: a stateful `gh`, and `sudo`,
 * `agy`, `curl` and `timeout` stubs that record what they were given. Nothing here
 * touches the network or spends anything.
 *
 * DEFAULT_REPOS is rewritten in the installed COPY (the daemon no longer honours an
 * ISSUE_REPOS override, which is the point of the change), so a test can sweep one
 * repo without editing the real file.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY = fileURLToPath(new URL("../../../deploy/", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./fakes/fake-gh.sh", import.meta.url));

/** The nine sections of .github/ISSUE_TEMPLATE/agent-task.md, in template order. */
export const BRIEF_HEADINGS = [
  "Goal",
  "Problem / observed behavior",
  "Expected behavior",
  "Evidence",
  "Files or subsystem in scope",
  "Constraints",
  "Explicitly forbidden",
  "Verification commands",
  "Acceptance criteria",
] as const;

/** A brief with every section filled in: what the daemon must claim. */
export function goodBrief(): string {
  return BRIEF_HEADINGS.map((h) => `## ${h}\n\nSomething concrete for ${h}.\n`).join("\n");
}

/** The six agent:* labels onboard-repo.sh creates and the daemon uses. */
export const AGENT_LABELS = [
  "agent:ready",
  "agent:working",
  "agent:review",
  "agent:failed",
  "agent:blocked",
  "agent:needs-brief",
] as const;

/** The labels that name the coding CLI an issue or PR belongs to. A repo gets them from onboard-repo.sh, or lazily from the daemon. */
export const ENGINE_LABELS = ["engine:agy", "engine:claude"] as const;

/** Synthetic credentials, assembled at run time so no scanner sees a contiguous key in the source. */
export const FAKE_GEMINI_KEY = "AI" + "za" + "Sy" + "k".repeat(33);
export const FAKE_TELEGRAM_TOKEN = "987654321" + ":" + "T".repeat(35);
/** A Claude Code OAuth token as `claude setup-token` prints it, assembled so no scanner sees a contiguous one. */
export const FAKE_CLAUDE_TOKEN = "sk-ant-" + "oat01-" + "C".repeat(40);

/** Real tools the daemon and its helpers need, symlinked into a hermetic PATH. */
const TOOLS = [
  "bash", "sh", "env", "awk", "sed", "grep", "tr", "cut", "head", "tail", "wc", "date", "mkdir", "rm", "mv", "cp",
  "cat", "find", "sleep", "basename", "dirname", "mktemp", "chmod", "chown", "hostname", "readlink", "stat", "git",
  "jq", "sort", "uniq", "touch", "ls", "id", "ln", "tee", "xargs", "comm", "diff", "sha256sum", "shasum", "realpath",
  "true", "false", "test", "expr", "printf", "seq", "uname",
];

/** git with its chatter captured: a local bare origin makes protocol-v2 push print warnings that are not test output. */
function git(args: readonly string[]): void {
  execFileSync("git", [...args], { stdio: ["ignore", "pipe", "pipe"] });
}

export interface IssueSpec {
  readonly repo?: string;
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly comments?: readonly string[];
  readonly state?: "open" | "closed";
}

export interface PrSpec {
  readonly repo?: string;
  readonly number: number;
  readonly headRefName: string;
  readonly headRefOid?: string;
  readonly isDraft?: boolean;
  /** OPEN (default), MERGED or CLOSED. Only an OPEN PR is listed, as `gh pr list --state open` does. */
  readonly state?: "OPEN" | "MERGED" | "CLOSED";
  readonly comments?: readonly string[];
  /** CI as `gh pr checks` reports it. `required: false` is a check branch protection does not require. */
  readonly checks?: readonly { readonly name: string; readonly bucket: "pass" | "fail" | "pending"; readonly state?: string; readonly required?: boolean }[];
}

export interface TickOptions {
  readonly args?: readonly string[];
  /** What the fake `agy` prints (stdout and stderr both land in the run log). */
  readonly agyOut?: string;
  readonly agyRc?: number;
  /** Bash run INSIDE the fake agy, in the workspace: simulates work or a founder acting mid-run. */
  readonly agyHook?: string;
  /** Seconds the fake agy stays alive after printing, so the daemon's live progress loop sees its output. */
  readonly agySleepAfter?: number;
  /** What the fake `claude` prints (stdout and stderr both land in the run log). */
  readonly claudeOut?: string;
  readonly claudeRc?: number;
  /** Bash run INSIDE the fake claude, in the workspace. */
  readonly claudeHook?: string;
  readonly claudeSleepAfter?: number;
  /** Exit code of the fake `curl`: non-zero = "Telegram is down". */
  readonly curlRc?: number;
  readonly env?: Record<string, string>;
  /** Tools to leave off the PATH (e.g. "jq" to simulate a missing dependency). */
  readonly withoutTools?: readonly string[];
  /** Skip the fake `agy` stub, so `command -v agy` fails for the antigravity user. */
  readonly noAgy?: boolean;
}

export interface TickResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TelegramCall {
  readonly kind: string;
  readonly text: string;
}

interface RepoState {
  labels: string[];
  /** Branches `gh api repos/<slug>/branches/<name>` finds. Absent means just `main`. */
  branches?: string[];
  issues: Record<string, { title: string; body: string; labels: string[]; state: string; comments: { body: string }[] }>;
  prs: {
    number: number;
    headRefName: string;
    headRefOid?: string;
    isDraft?: boolean;
    state?: string;
    comments: { body: string }[];
    labels?: string[];
    checks?: { name: string; bucket: string; state?: string; required?: boolean }[];
  }[];
}
interface GhState {
  authOk: boolean;
  failIssueEdit: boolean;
  failLabelList: boolean;
  /** `gh api` answers 502 (an outage, as opposed to a 404). */
  failApi?: boolean;
  repos: Record<string, RepoState>;
}

export class DispatchSandbox {
  readonly root: string;
  readonly home: string;
  readonly installDir: string;
  readonly stubs: string;
  readonly tools: string;
  readonly wsBase: string;
  readonly reviewBase: string;
  readonly envFile: string;
  readonly repos: readonly string[];

  private readonly ghState: string;
  private readonly ghCalls: string;
  private readonly agyCalls: string;
  private readonly agyEnvLog: string;
  private readonly agyPromptLog: string;
  private readonly claudeCalls: string;
  private readonly claudeEnvLog: string;
  private readonly claudeArgvLog: string;
  private readonly claudePromptLog: string;
  private readonly sudoArgv: string;
  private readonly sends: string;

  /** `provision: false` starts every repo without its review checkout and agy workspace (a fresh VPS). */
  constructor(repos: readonly string[] = ["owner/founderos"], opts: { provision?: boolean } = {}) {
    this.repos = repos;
    this.root = mkdtempSync(join(tmpdir(), "agent-dispatch-"));
    this.home = join(this.root, "home");
    this.installDir = join(this.home, "bin");
    this.stubs = join(this.root, "stubs");
    this.tools = join(this.root, "tools");
    this.wsBase = join(this.root, "ws");
    this.reviewBase = join(this.root, "review");
    this.envFile = join(this.root, "founderos.env");
    this.ghState = join(this.root, "gh-state.json");
    this.ghCalls = join(this.root, "gh-calls.log");
    this.agyCalls = join(this.root, "agy-calls.log");
    this.agyEnvLog = join(this.root, "agy-env.log");
    this.agyPromptLog = join(this.root, "agy-prompts.log");
    this.claudeCalls = join(this.root, "claude-calls.log");
    this.claudeEnvLog = join(this.root, "claude-env.log");
    this.claudeArgvLog = join(this.root, "claude-argv.log");
    this.claudePromptLog = join(this.root, "claude-prompts.log");
    this.sudoArgv = join(this.root, "sudo-argv.log");
    this.sends = join(this.root, "telegram.log");

    for (const d of [join(this.home, ".claude"), this.installDir, this.stubs, this.tools, this.wsBase, this.reviewBase]) {
      mkdirSync(d, { recursive: true });
    }
    this.installDaemon();
    this.installStubs();
    this.installTools();
    writeFileSync(
      this.envFile,
      `TELEGRAM_BOT_TOKEN=${FAKE_TELEGRAM_TOKEN}\nTELEGRAM_CHAT_ID=1\nGOOGLE_GENERATIVE_AI_API_KEY=${FAKE_GEMINI_KEY}\n`,
    );

    this.touchEnvFile(Math.floor(Date.now() / 1000) - 3600);

    const state: GhState = { authOk: true, failIssueEdit: false, failLabelList: false, repos: {} };
    for (const r of repos) {
      state.repos[r] = { labels: [...AGENT_LABELS, ...ENGINE_LABELS], issues: {}, prs: [] };
      this.ensureOrigin(r);
      if (opts.provision !== false) {
        this.ensureWorkspace(r);
        this.ensureReviewCheckout(r);
      }
    }
    writeFileSync(this.ghState, JSON.stringify(state));
  }

  destroy(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ layout

  /** Directory name the daemon (and onboard-repo.sh) use for a repo: `founderos` for FounderOS, else its name. */
  static dirName(slug: string): string {
    const name = basename(slug);
    return slug.includes("FounderOS") ? "founderos" : name;
  }

  private installDaemon(): void {
    const src = readFileSync(join(DEPLOY, "agent-dispatch"), "utf8");
    const line = /^DEFAULT_REPOS=\(.*\)$/m;
    if (!line.test(src)) throw new Error("deploy/agent-dispatch no longer declares DEFAULT_REPOS=( … ) on one line");
    const list = this.repos.map((r) => `"${r}"`).join(" ");
    writeFileSync(join(this.installDir, "agent-dispatch"), src.replace(line, `DEFAULT_REPOS=(${list})`), { mode: 0o755 });
    mkdirSync(join(this.installDir, "lib"), { recursive: true });
    for (const f of readdirSync(join(DEPLOY, "lib")).filter((n) => n.endsWith(".sh"))) {
      copyFileSync(join(DEPLOY, "lib", f), join(this.installDir, "lib", f));
    }
    if (existsSync(join(DEPLOY, "onboard-repo.sh"))) {
      copyFileSync(join(DEPLOY, "onboard-repo.sh"), join(this.installDir, "onboard-repo.sh"));
      chmodSync(join(this.installDir, "onboard-repo.sh"), 0o755);
    }
  }

  private stub(name: string, body: string): void {
    const p = join(this.stubs, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }

  private installStubs(): void {
    // gh: the stateful fake, addressed by absolute path so PATH does not matter.
    this.stub("gh", `exec bash "${FAKE_GH}" "$@"`);
    // sudo -u antigravity -- bash -lc SCRIPT _ args  ->  run it as ourselves, keeping stdin.
    this.stub("sudo", `printf '%s\\n' "$*" >>"$SUDO_ARGV"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
    this.stub("timeout", `shift; exec "$@"`);
    this.stub(
      "agy",
      `echo run >>"$AGY_CALLS"
printf '%s\\n' "\${GEMINI_API_KEY-<unset>}" >>"$AGY_ENV_LOG"
while [ $# -gt 0 ]; do case "$1" in --print) printf '%s\\n----\\n' "$2" >>"$AGY_PROMPT_LOG"; shift 2 ;; *) shift ;; esac; done
[ -n "\${AGY_HOOK:-}" ] && bash -c "$AGY_HOOK"
printf '%s\\n' "\${AGY_OUT:-}"
sleep "\${AGY_SLEEP_AFTER:-0}"
exit "\${AGY_RC:-1}"`,
    );
    // claude: records the run, the token it was handed IN ITS ENVIRONMENT, its whole argv (so a test can prove the
    // token is not there) and its -p prompt; then behaves as the test says.
    this.stub(
      "claude",
      `echo run >>"$CLAUDE_CALLS"
printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-<unset>}" >>"$CLAUDE_ENV_LOG"
printf '%s\\n' "$*" >>"$CLAUDE_ARGV_LOG"
while [ $# -gt 0 ]; do case "$1" in -p) printf '%s\\n----\\n' "$2" >>"$CLAUDE_PROMPT_LOG"; shift 2 ;; *) shift ;; esac; done
[ -n "\${CLAUDE_HOOK:-}" ] && bash -c "$CLAUDE_HOOK"
printf '%s\\n' "\${CLAUDE_OUT:-}"
sleep "\${CLAUDE_SLEEP_AFTER:-0}"
exit "\${CLAUDE_RC:-1}"`,
    );
    // Every Telegram call lands in $SENDS as "<kind>\\t<text>\\n@@\\n"; nothing reaches the network.
    this.stub(
      "curl",
      `kind=""; text=""
for a in "$@"; do case "$a" in
  */sendMessage) kind=send ;;
  */editMessageText) kind=edit ;;
  */deleteMessage) kind=delete ;;
  text=*) text="\${a#text=}" ;;
esac; done
printf '%s\\t%s\\n@@\\n' "$kind" "$text" >>"$SENDS"
[ "\${CURL_RC:-0}" -ne 0 ] && exit "$CURL_RC"
printf '{"ok":true,"result":{"message_id":7}}\\n'`,
    );
  }

  private installTools(): void {
    for (const t of TOOLS) {
      // /usr/sbin: macOS keeps chown there (Linux has it in /bin), and onboard-repo.sh needs it.
      for (const dir of ["/usr/bin", "/bin", "/usr/local/bin", "/usr/sbin", "/sbin"]) {
        const p = join(dir, t);
        if (existsSync(p) && !existsSync(join(this.tools, t))) {
          symlinkSync(p, join(this.tools, t));
          break;
        }
      }
    }
  }

  /** The bare repository standing in for github.com/<slug>: it has one commit on `main`. */
  ensureOrigin(slug: string): string {
    const bare = join(this.root, `origin-${DispatchSandbox.dirName(slug)}.git`);
    if (existsSync(bare)) return bare;
    const seed = join(this.root, `seed-${DispatchSandbox.dirName(slug)}`);
    git(["init", "-q", "--bare", "-b", "main", bare]);
    git(["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "x\n");
    git(["-C", seed, "add", "."]);
    git(["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    git(["-C", seed, "push", "-q", bare, "main"]);
    rmSync(seed, { recursive: true, force: true });
    return bare;
  }

  /** Environment that makes `https://github.com/<slug>.git` resolve to the local bare origin (real git, no network). */
  gitEnv(): Record<string, string> {
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(this.repos.length) };
    this.repos.forEach((r, i) => {
      env[`GIT_CONFIG_KEY_${i}`] = `url.${this.ensureOrigin(r)}.insteadOf`;
      env[`GIT_CONFIG_VALUE_${i}`] = `https://github.com/${r}.git`;
    });
    return env;
  }

  /** A workspace the daemon can check a branch out in: a real repo whose origin has `main`. */
  ensureWorkspace(slug: string): string {
    const name = DispatchSandbox.dirName(slug);
    const ws = join(this.wsBase, name);
    if (existsSync(join(ws, ".git"))) return ws;
    const bare = this.ensureOrigin(slug);
    git(["clone", "-q", bare, ws]);
    git(["-C", ws, "remote", "set-url", "origin", `https://github.com/${slug}.git`]);
    git(["-C", ws, "config", `url.${bare}.insteadOf`, `https://github.com/${slug}.git`]);
    return ws;
  }

  ensureReviewCheckout(slug: string): string {
    const dir = join(this.reviewBase, DispatchSandbox.dirName(slug));
    if (!existsSync(join(dir, ".git"))) {
      const bare = this.ensureOrigin(slug);
      git(["clone", "-q", bare, dir]);
      git(["-C", dir, "remote", "set-url", "origin", `https://github.com/${slug}.git`]);
      git(["-C", dir, "config", `url.${bare}.insteadOf`, `https://github.com/${slug}.git`]);
    }
    return dir;
  }

  removeReviewCheckout(slug: string): void {
    rmSync(join(this.reviewBase, DispatchSandbox.dirName(slug)), { recursive: true, force: true });
  }

  removeWorkspace(slug: string): void {
    rmSync(join(this.wsBase, DispatchSandbox.dirName(slug)), { recursive: true, force: true });
  }

  /** Set the key file's mtime (epoch seconds): the daemon resumes from an auth pause when it changes. */
  touchEnvFile(epochSeconds: number): void {
    utimesSync(this.envFile, epochSeconds, epochSeconds);
  }

  /** Overwrite the daemon's env file (keeps the mtime an hour in the past unless the caller touches it). */
  writeEnvFile(content: string): void {
    writeFileSync(this.envFile, content);
    this.touchEnvFile(Math.floor(Date.now() / 1000) - 3600);
  }

  /** Put a branch with one commit on the workspace's origin, as an earlier Antigravity run would have. */
  ensureRemoteBranch(slug: string, branch: string): void {
    const ws = this.ensureWorkspace(slug);
    git(["-C", ws, "checkout", "-q", "-b", branch, "origin/main"]);
    writeFileSync(join(ws, `${branch.replace(/[^a-z0-9]+/gi, "-")}.txt`), "work\n");
    git(["-C", ws, "add", "."]);
    git(["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"]);
    git(["-C", ws, "push", "-q", "origin", branch]);
    git(["-C", ws, "checkout", "-q", "main"]);
    git(["-C", ws, "branch", "-q", "-D", branch]);
    git(["-C", ws, "fetch", "-q", "origin"]);
  }

  // ------------------------------------------------------------ fake GitHub

  private readGh(): GhState {
    return JSON.parse(readFileSync(this.ghState, "utf8")) as GhState;
  }
  private writeGh(s: GhState): void {
    writeFileSync(this.ghState, JSON.stringify(s));
  }
  private repoState(s: GhState, slug: string): RepoState {
    const r = s.repos[slug];
    if (!r) throw new Error(`sandbox has no repo ${slug}`);
    return r;
  }

  addIssue(spec: IssueSpec): void {
    const s = this.readGh();
    const slug = spec.repo ?? this.repos[0] ?? "owner/founderos";
    this.repoState(s, slug).issues[String(spec.number)] = {
      title: spec.title ?? `fix(docs): task ${spec.number}`,
      body: spec.body ?? goodBrief(),
      labels: [...(spec.labels ?? ["agent:ready"])],
      state: spec.state ?? "open",
      comments: (spec.comments ?? []).map((body) => ({ body })),
    };
    this.writeGh(s);
  }

  addPr(spec: PrSpec): void {
    const s = this.readGh();
    const slug = spec.repo ?? this.repos[0] ?? "owner/founderos";
    this.repoState(s, slug).prs.push({
      number: spec.number,
      headRefName: spec.headRefName,
      headRefOid: spec.headRefOid ?? "a".repeat(40),
      isDraft: spec.isDraft ?? true,
      state: spec.state ?? "OPEN",
      comments: (spec.comments ?? []).map((body) => ({ body })),
      ...(spec.checks ? { checks: spec.checks.map((c) => ({ ...c })) } : {}),
    });
    this.writeGh(s);
  }

  /**
   * Gives a repo a `beta` branch: GitHub reports it (`gh api …/branches/beta`) AND the bare origin really has it,
   * so the daemon can check a task branch out from it. `["main", "beta"]` is the FounderOS shape.
   */
  addBetaBranch(slug: string): void {
    const s = this.readGh();
    this.repoState(s, slug).branches = ["main", "beta"];
    this.writeGh(s);
    const ws = this.ensureWorkspace(slug);
    git(["-C", ws, "fetch", "-q", "origin"]);
    git(["-C", ws, "push", "-q", "origin", "origin/main:refs/heads/beta"]);
    git(["-C", ws, "fetch", "-q", "origin"]);
  }

  setRepoLabels(slug: string, labels: readonly string[]): void {
    const s = this.readGh();
    this.repoState(s, slug).labels = [...labels];
    this.writeGh(s);
  }

  patchGh(patch: Partial<Pick<GhState, "authOk" | "failIssueEdit" | "failLabelList" | "failApi">>): void {
    this.writeGh({ ...this.readGh(), ...patch });
  }

  issue(number: number, slug?: string): RepoState["issues"][string] {
    const s = this.readGh();
    const i = this.repoState(s, slug ?? this.repos[0] ?? "owner/founderos").issues[String(number)];
    if (!i) throw new Error(`no issue #${number}`);
    return i;
  }
  labelsOf(number: number, slug?: string): string[] {
    return this.issue(number, slug).labels;
  }
  commentsOf(number: number, slug?: string): string[] {
    return this.issue(number, slug).comments.map((c) => c.body);
  }
  repoLabels(slug?: string): string[] {
    return this.repoState(this.readGh(), slug ?? this.repos[0] ?? "owner/founderos").labels;
  }
  prCommentsOf(number: number, slug?: string): string[] {
    const s = this.readGh();
    const p = this.repoState(s, slug ?? this.repos[0] ?? "owner/founderos").prs.find((x) => x.number === number);
    return (p?.comments ?? []).map((c) => c.body);
  }
  prs(slug?: string): RepoState["prs"] {
    return this.repoState(this.readGh(), slug ?? this.repos[0] ?? "owner/founderos").prs;
  }

  // ----------------------------------------------------------------- running

  private filteredTools(opts: TickOptions): string {
    const dir = join(this.root, `tools-${(opts.withoutTools ?? []).join("-")}${opts.noAgy ? "-noagy" : ""}`);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      for (const t of readdirSync(this.tools)) {
        if (!(opts.withoutTools ?? []).includes(t)) symlinkSync(join(this.tools, t), join(dir, t));
      }
    }
    return dir;
  }

  /** One `agent-dispatch` invocation, as cron runs it. */
  tick(opts: TickOptions = {}): TickResult {
    let stubsDir = this.stubs;
    if (opts.noAgy) {
      // A stubs dir without agy: the fake sudo then finds no `agy` for the antigravity user.
      stubsDir = join(this.root, "stubs-noagy");
      if (!existsSync(stubsDir)) {
        mkdirSync(stubsDir, { recursive: true });
        for (const n of readdirSync(this.stubs)) if (n !== "agy") symlinkSync(join(this.stubs, n), join(stubsDir, n));
      }
    }
    const path = `${stubsDir}:${opts.withoutTools?.length ? this.filteredTools(opts) : this.tools}`;
    const r = spawnSync("bash", [join(this.installDir, "agent-dispatch"), ...(opts.args ?? [])], {
      env: {
        PATH: path,
        HOME: this.home,
        AGENT_DISPATCH_WORKSPACE_BASE: this.wsBase,
        ONBOARD_REVIEW_BASE: this.reviewBase,
        AGENT_DISPATCH_USER: userInfo().username,
        AGENT_DISPATCH_ENV_FILE: this.envFile,
        AGENT_DISPATCH_PROGRESS_POLL_SEC: "0",
        GH_STATE: this.ghState,
        GH_CALLS: this.ghCalls,
        AGY_CALLS: this.agyCalls,
        AGY_ENV_LOG: this.agyEnvLog,
        AGY_PROMPT_LOG: this.agyPromptLog,
        SUDO_ARGV: this.sudoArgv,
        SENDS: this.sends,
        AGY_OUT: opts.agyOut ?? "",
        AGY_RC: String(opts.agyRc ?? 1),
        CLAUDE_CALLS: this.claudeCalls,
        CLAUDE_ENV_LOG: this.claudeEnvLog,
        CLAUDE_ARGV_LOG: this.claudeArgvLog,
        CLAUDE_PROMPT_LOG: this.claudePromptLog,
        CLAUDE_OUT: opts.claudeOut ?? "",
        CLAUDE_RC: String(opts.claudeRc ?? 1),
        CLAUDE_HOOK: opts.claudeHook ?? "",
        CLAUDE_SLEEP_AFTER: String(opts.claudeSleepAfter ?? 0),
        AGY_HOOK: opts.agyHook ?? "",
        AGY_SLEEP_AFTER: String(opts.agySleepAfter ?? 0),
        CURL_RC: String(opts.curlRc ?? 0),
        ...opts.env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  /** onboard-repo.sh from the deployed layout (~/bin), against the same fakes and the local bare origins. */
  onboard(args: readonly string[], opts: { env?: Record<string, string>; stubs?: Record<string, string> } = {}): TickResult {
    let stubsDir = this.stubs;
    if (opts.stubs) {
      stubsDir = join(this.root, `stubs-onboard-${Object.keys(opts.stubs).join("-")}`);
      mkdirSync(stubsDir, { recursive: true });
      for (const n of readdirSync(this.stubs)) if (!(n in (opts.stubs ?? {}))) symlinkSync(join(this.stubs, n), join(stubsDir, n));
      for (const [name, body] of Object.entries(opts.stubs)) {
        writeFileSync(join(stubsDir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      }
    }
    const r = spawnSync("bash", [join(this.installDir, "onboard-repo.sh"), ...args], {
      env: {
        PATH: `${stubsDir}:${this.tools}`,
        HOME: this.home,
        ONBOARD_REVIEW_BASE: this.reviewBase,
        AGENT_DISPATCH_WORKSPACE_BASE: this.wsBase,
        AGENT_DISPATCH_USER: userInfo().username,
        GH_STATE: this.ghState,
        GH_CALLS: this.ghCalls,
        SUDO_ARGV: this.sudoArgv,
        ...this.gitEnv(),
        ...opts.env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  /** The real deploy/agent-dispatch, in the repo layout (helpers in deploy/lib), with the same stubs. */
  runInPlace(args: readonly string[]): TickResult {
    const r = spawnSync("bash", [join(DEPLOY, "agent-dispatch"), ...args], {
      env: {
        PATH: `${this.stubs}:${this.tools}`,
        HOME: this.home,
        AGENT_DISPATCH_WORKSPACE_BASE: this.wsBase,
        AGENT_DISPATCH_USER: userInfo().username,
        AGENT_DISPATCH_ENV_FILE: this.envFile,
        GH_STATE: this.ghState,
        GH_CALLS: this.ghCalls,
        SUDO_ARGV: this.sudoArgv,
        SENDS: this.sends,
        AGY_CALLS: this.agyCalls,
        AGY_ENV_LOG: this.agyEnvLog,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  // -------------------------------------------------------------- inspection

  telegram(): TelegramCall[] {
    if (!existsSync(this.sends)) return [];
    return readFileSync(this.sends, "utf8")
      .split("\n@@\n")
      .filter((s) => s.trim() !== "")
      .map((rec) => {
        const tab = rec.indexOf("\t");
        return { kind: rec.slice(0, tab), text: rec.slice(tab + 1) };
      });
  }

  /** What the founder is notified of: sendMessage texts, minus the "🔧 … starting" progress placeholders. */
  messages(): string[] {
    return this.telegram()
      .filter((c) => c.kind === "send" && !c.text.startsWith("🔧"))
      .map((c) => c.text);
  }

  ghLog(): string {
    return existsSync(this.ghCalls) ? readFileSync(this.ghCalls, "utf8") : "";
  }
  ghCallList(): string[] {
    return this.ghLog().split("\n").filter(Boolean);
  }
  agyRuns(): number {
    return existsSync(this.agyCalls) ? readFileSync(this.agyCalls, "utf8").split("\n").filter(Boolean).length : 0;
  }
  /** The prompt each fake agy run was given (its --print argument), one entry per run. */
  agyPrompts(): string[] {
    return existsSync(this.agyPromptLog)
      ? readFileSync(this.agyPromptLog, "utf8").split("\n----\n").filter((p) => p.trim() !== "")
      : [];
  }
  /** The GEMINI_API_KEY value each fake agy run saw in its ENVIRONMENT. */
  agyKeysSeen(): string[] {
    return existsSync(this.agyEnvLog) ? readFileSync(this.agyEnvLog, "utf8").split("\n").filter(Boolean) : [];
  }
  claudeRuns(): number {
    return existsSync(this.claudeCalls) ? readFileSync(this.claudeCalls, "utf8").split("\n").filter(Boolean).length : 0;
  }
  /** The prompt each fake claude run was given (its -p argument), one entry per run. */
  claudePrompts(): string[] {
    return existsSync(this.claudePromptLog)
      ? readFileSync(this.claudePromptLog, "utf8").split("\n----\n").filter((p) => p.trim() !== "")
      : [];
  }
  /** The CLAUDE_CODE_OAUTH_TOKEN value each fake claude run saw in its ENVIRONMENT. */
  claudeTokensSeen(): string[] {
    return existsSync(this.claudeEnvLog) ? readFileSync(this.claudeEnvLog, "utf8").split("\n").filter(Boolean) : [];
  }
  /** Every argument of every fake claude run, one line per run: the token must never be in it. */
  claudeArgv(): string {
    return existsSync(this.claudeArgvLog) ? readFileSync(this.claudeArgvLog, "utf8") : "";
  }
  /** Where the founder's Claude Code token lives (line 1), as `claude setup-token` left it. */
  claudeTokenPath(): string {
    return join(this.home, ".claude", "claude-code.token");
  }
  writeClaudeToken(token: string = FAKE_CLAUDE_TOKEN): void {
    writeFileSync(this.claudeTokenPath(), `${token}\n`, { mode: 0o600 });
    utimesSync(this.claudeTokenPath(), Math.floor(Date.now() / 1000) - 3600, Math.floor(Date.now() / 1000) - 3600);
  }
  /** Set the default coding CLI the way the bot's /engine does: one word in ~/.claude/coding-engine. */
  setDefaultEngine(engine: string): void {
    writeFileSync(this.statePath("coding-engine"), `${engine}\n`);
  }
  /** The labels on PR `number`, as the fake GitHub holds them (set by `gh api …/issues/N/labels`). */
  prLabelsOf(number: number, slug?: string): string[] {
    const p = this.prs(slug).find((x) => x.number === number);
    return p?.labels ?? [];
  }
  sudoCalls(): string[] {
    return existsSync(this.sudoArgv) ? readFileSync(this.sudoArgv, "utf8").split("\n").filter(Boolean) : [];
  }
  log(): string {
    const p = join(this.home, ".claude", "agent-dispatch.log");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }
  reviewDir(slug: string): string {
    return join(this.reviewBase, DispatchSandbox.dirName(slug));
  }
  workspaceDir(slug: string): string {
    return join(this.wsBase, DispatchSandbox.dirName(slug));
  }
  clearCallLogs(): void {
    for (const f of [this.ghCalls, this.sudoArgv, this.sends]) rmSync(f, { force: true });
  }
  statePath(name: string): string {
    return join(this.home, ".claude", name);
  }
  hasState(name: string): boolean {
    return existsSync(this.statePath(name));
  }
  readState(name: string): string {
    return readFileSync(this.statePath(name), "utf8");
  }
  /** Everything the daemon wrote under ~/.claude, for "the secret is nowhere" assertions. */
  allStateText(): string {
    const dir = join(this.home, ".claude");
    return readdirSync(dir)
      .map((f) => {
        try {
          return readFileSync(join(dir, f), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  daemonPath(): string {
    return join(this.installDir, "agent-dispatch");
  }
  daemonText(): string {
    return readFileSync(this.daemonPath(), "utf8");
  }
}
