/**
 * pr-brain's long-lived Claude token — deploy/vps-daemons/pr-brain, plan 2026-09-29 item 8.
 * =========================================================================================
 * The interactive Claude login expires, and an expired login pauses every gate until somebody
 * ssh'es in and runs /login. A token made once with `claude setup-token` and kept in
 * ~/.claude/pr-brain.token (mode 0600; line 1 the token, line 2 the date it was created) removes
 * that chore. What must hold, and is pinned here against the real script and stub binaries:
 *
 *   - the token reaches `claude` through its ENVIRONMENT, for the preflight and for the gate;
 *   - it never reaches `gh`, never an argument, never the log, never a Telegram message;
 *   - a token file that other users can read is not used, and the founder is told once;
 *   - an old token is announced once, counted from the date on line 2 (330 days), and a renewed
 *     token with a new date re-arms the warning;
 *   - when Claude rejects the token the pause message names the token file, not /login.
 *
 * The token's real lifetime is unverified (the script says so); the 330 days is a named constant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));

/** Not a real token: long enough to be unmistakable in a log or an argv. */
const TOKEN = "sk-ant-oat01-TESTTOKENTESTTOKENTESTTOKEN0123456789";
const CREATED = "2026-01-01";
const TOKEN_WARN_DAYS = 330; // the script's TOKEN_WARN_DAYS; the boundary tests below pin it

let root: string;
let home: string;
let bin: string;
let sends: string;
let claudeSeen: string;
let ghSeen: string;
let claudeArgv: string;

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

const epochOf = (isoDay: string, plusDays = 0): string => String(Date.parse(`${isoDay}T00:00:00Z`) / 1000 + plusDays * 86_400);
const tokenPath = (): string => join(home, ".claude", "pr-brain.token");

function writeToken(content: string, mode = 0o600): void {
  writeFileSync(tokenPath(), content);
  chmodSync(tokenPath(), mode);
}

/** One sweep over one open PR: a preflight call, then a gate call. */
function sweep(opts: { preflight?: string; nowEpoch?: string; args?: string[] } = {}): void {
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: home,
    PR_BRAIN_ROOT: join(root, "repos"),
    PR_BRAIN_ENV_FILE: join(root, ".env"),
    PR_BRAIN_OWNER: "owner",
    // These pin the Claude engine; the default engine is agy (pr-brain-agy.test.ts).
    PR_BRAIN_ENGINE: "claude",
    QA_APP_ROOT: join(root, "no-founderos"),
    FAKE_PREFLIGHT: opts.preflight ?? "ok",
    FAKE_HEAD: "aaaa1111",
    FAKE_PRS: "56 aaaa1111",
    CLAUDE_SEEN: claudeSeen,
    CLAUDE_ARGV: claudeArgv,
    GH_SEEN: ghSeen,
    SENDS: sends,
  };
  if (opts.nowEpoch !== undefined) env["PR_BRAIN_NOW_EPOCH"] = opts.nowEpoch;
  spawnSync("bash", [SCRIPT, ...(opts.args ?? [])], { env, encoding: "utf8", timeout: 30_000 });
}

const linesOf = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : []);
/** What each claude call saw in CLAUDE_CODE_OAUTH_TOKEN; "unset" when it saw nothing. */
const claudeTokens = (): string[] => (existsSync(claudeSeen) ? readFileSync(claudeSeen, "utf8").split("\n").slice(0, -1).map((l) => l || "unset") : []);
const telegramSends = (): string[] => (existsSync(sends) ? readFileSync(sends, "utf8").split("\n@@\n").filter((s) => s.trim() !== "") : []);
/** Messages about the token file (every one names it). A gated PR sends its own, unrelated, message too. */
const tokenMessages = (): string[] => telegramSends().filter((m) => m.includes("pr-brain.token"));
const logText = (): string => readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-token-"));
  home = join(root, "home");
  bin = join(root, "bin");
  sends = join(root, "sends.log");
  claudeSeen = join(root, "claude-token-seen.log");
  ghSeen = join(root, "gh-token-seen.log");
  claudeArgv = join(root, "claude-argv.log");
  const repo = join(root, "repos", "oplify-messaging-api");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/oplify-messaging-api.git"], { cwd: repo });

  // Records what the process's environment held for the token, and its arguments. Like the real
  // CLI it reads piped stdin, which inside the sweep's `while read` loop would swallow the next PR.
  stub(
    "claude",
    `[ -t 0 ] || cat >/dev/null
printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN:-}" >>"$CLAUDE_SEEN"
printf '%s\\n' "$*" >>"$CLAUDE_ARGV"
case "$*" in
  *"reply with the single word ok"*) printf '%s\\n' "$FAKE_PREFLIGHT"; exit 0 ;;
  *) printf 'done\\n'; exit 0 ;;
esac`,
  );
  stub(
    "gh",
    `printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN:-unset}" >>"$GH_SEEN"
case "$*" in
  "api user"*) echo owner ;;
  "auth status"*) exit 0 ;;
  "pr list"*) [ -n "$FAKE_PRS" ] && echo "$FAKE_PRS" ;;
  *"headRefOid"*) echo "$FAKE_HEAD" ;;
  *"--json comments"*) echo "" ;;
  *"reviewDecision"*) echo "CLEARED — marked ready · title" ;;
  *"baseRefName"*) echo main ;;
  *"--json url"*) echo "https://github.com/owner/oplify-messaging-api/pull/56" ;;
  *) exit 0 ;;
esac`,
  );
  stub(
    "curl",
    `for a in "$@"; do case "$a" in
  text=*) printf '%s\\n@@\\n' "\${a#text=}" >>"$SENDS" ;;
esac; done; exit 0`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pr-brain — the Claude token file", () => {
  it("without a token file, claude runs exactly as before: no CLAUDE_CODE_OAUTH_TOKEN, no message", () => {
    sweep();
    expect(claudeTokens()).toEqual(["unset", "unset"]); // the preflight and the gate
    expect(tokenMessages()).toEqual([]);
  });

  it("hands the token to claude through its environment, for the preflight and for the gate", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`);
    sweep({ nowEpoch: epochOf(CREATED, 10) });
    expect(claudeTokens()).toEqual([TOKEN, TOKEN]);
  });

  it("never lets the token reach gh, an argument, the log or a Telegram message", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`);
    sweep({ nowEpoch: epochOf(CREATED, 10), preflight: "ok" });
    sweep({ nowEpoch: epochOf(CREATED, 10), preflight: "Invalid API key · Please run /login" }); // an outage path logs and sends text too
    expect(new Set(linesOf(ghSeen))).toEqual(new Set(["unset"]));
    expect(linesOf(claudeArgv).join("\n")).not.toContain(TOKEN);
    expect(logText()).not.toContain(TOKEN);
    expect(telegramSends().join("\n")).not.toContain(TOKEN);
  });

  it("trims Windows line endings off the token and the date", () => {
    writeToken(`${TOKEN}\r\n${CREATED}\r\n`);
    sweep({ nowEpoch: epochOf(CREATED, 10) });
    expect(claudeTokens()).toEqual([TOKEN, TOKEN]);
    expect(tokenMessages()).toEqual([]);
  });
});

describe("pr-brain — a token file that cannot be trusted", () => {
  it("does not use a token that other users can read, and says so ONCE", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`, 0o644);
    for (let i = 0; i < 3; i++) sweep({ nowEpoch: epochOf(CREATED, 10) });
    expect(claudeTokens().every((t) => t === "unset")).toBe(true);
    const msgs = tokenMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("mode 644");
    expect(msgs[0]).toContain("chmod 600");
    expect(msgs.join("\n")).not.toContain(TOKEN);
  });

  it("ignores an empty token file and says so once", () => {
    writeToken("\n");
    sweep();
    sweep();
    expect(claudeTokens().every((t) => t === "unset")).toBe(true);
    expect(tokenMessages()).toHaveLength(1);
    expect(tokenMessages()[0]).toContain("empty");
  });

  it("a dry run reports the problem in its output but neither sends nor remembers, so the real run still tells the founder", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`, 0o644);
    sweep({ args: ["--dry-run"] });
    expect(tokenMessages()).toEqual([]);
    expect(existsSync(join(home, ".claude", "pr-brain.warned"))).toBe(false);
    sweep();
    expect(tokenMessages()).toHaveLength(1);
  });
});

describe("pr-brain — the token's age", () => {
  it(`stays quiet one day before ${TOKEN_WARN_DAYS} days`, () => {
    writeToken(`${TOKEN}\n${CREATED}\n`);
    sweep({ nowEpoch: epochOf(CREATED, TOKEN_WARN_DAYS - 1) });
    expect(tokenMessages()).toEqual([]);
  });

  it(`warns once at ${TOKEN_WARN_DAYS} days, names the date and the fix, still uses the token, and does not repeat`, () => {
    writeToken(`${TOKEN}\n${CREATED}\n`);
    for (let i = 0; i < 3; i++) sweep({ nowEpoch: epochOf(CREATED, TOKEN_WARN_DAYS) });
    expect(claudeTokens().every((t) => t === TOKEN)).toBe(true);
    const msgs = tokenMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(CREATED);
    expect(msgs[0]).toContain(`${TOKEN_WARN_DAYS} days`);
    expect(msgs[0]).toContain("claude setup-token");
    expect(msgs[0]).toContain("unverified"); // the lifetime is a guess, and the message says so
  });

  it("a renewed token with a new date re-arms the warning", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`);
    sweep({ nowEpoch: epochOf(CREATED, TOKEN_WARN_DAYS) });
    expect(tokenMessages()).toHaveLength(1);
    writeToken(`${TOKEN}\n2026-12-01\n`); // renewed: new date
    sweep({ nowEpoch: epochOf("2026-12-01", 5) });
    expect(tokenMessages()).toHaveLength(1); // fresh token, no warning
    sweep({ nowEpoch: epochOf("2026-12-01", TOKEN_WARN_DAYS) });
    expect(tokenMessages()).toHaveLength(2); // and it warns again when THIS one gets old
  });

  it("asks for the creation date when line 2 is missing or not a date, once, and still uses the token", () => {
    for (const body of [`${TOKEN}\n`, `${TOKEN}\nyesterday\n`, `${TOKEN}\n2026-13-45\n`]) {
      rmSync(join(home, ".claude", "pr-brain.warned"), { recursive: true, force: true });
      rmSync(sends, { force: true });
      rmSync(claudeSeen, { force: true });
      writeToken(body);
      sweep();
      sweep();
      expect(claudeTokens().every((t) => t === TOKEN), body).toBe(true);
      expect(tokenMessages(), body).toHaveLength(1);
      expect(tokenMessages()[0], body).toContain("creation date");
    }
  });
});

describe("pr-brain — when Claude rejects the credentials", () => {
  const REJECTED = "Invalid API key · Please run /login";

  it("names the token file and 'claude setup-token' when a token was in use, not /login", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`);
    sweep({ nowEpoch: epochOf(CREATED, 10), preflight: REJECTED });
    const msgs = tokenMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("PAUSED");
    expect(msgs[0]).toContain("rejected the token");
    expect(msgs[0]).toContain(tokenPath());
    expect(msgs[0]).toContain("claude setup-token");
    expect(msgs[0]).not.toContain(TOKEN);
  });

  it("without a token, still says /login and points at the permanent fix", () => {
    sweep({ preflight: REJECTED });
    const msgs = tokenMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("/login");
    expect(msgs[0]).toContain("claude setup-token");
    expect(msgs[0]).toContain(tokenPath());
  });

  it("leaves nothing but its own marker directory behind", () => {
    writeToken(`${TOKEN}\n${CREATED}\n`, 0o644);
    sweep();
    expect(readdirSync(join(home, ".claude", "pr-brain.warned")).length).toBe(1);
  });
});
