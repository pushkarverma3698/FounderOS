/**
 * pr-brain notification volume — deploy/vps-daemons/pr-brain.
 * ============================================================
 * On 2026-09-26 and 09-27 the founder got 72 Telegram messages a day, one per
 * 20-minute tick, all saying "⚠️ Gate FAILED to complete — oplify-messaging-api#56".
 * The cause was not the PR: Claude Code had hit its weekly usage limit. The
 * preflight only recognised an AUTH failure, so every tick dispatched a gate that
 * could not run, and every failed gate announced itself.
 *
 * These run the real script against stub `claude`, `gh` and `curl` binaries and
 * count the Telegram sends. The property pinned is the one the founder feels:
 * an outage is one message going down and one coming back, never one per tick.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url));
const LIMIT_MSG = "You've hit your weekly limit · resets 6am (UTC)";

let root: string;
let home: string;
let bin: string;
let repo: string;
let sends: string;
let claudeCalls: string;

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** One sweep. `preflight`/`gate` are what the fake claude prints for each call. */
function sweep(opts: {
  preflight: string;
  gate?: string;
  gateRc?: number;
  head?: string;
  appGate?: boolean;
  /** Open PRs as `gh pr list` prints them; "" = none. Default: PR 56 at `head`. */
  prs?: string;
  /** PR comment bodies; include the marker for `head` to mark it already gated. */
  comments?: string;
  /** Sweep a root with no repositories in it. */
  noRepos?: boolean;
}): void {
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: home,
    PR_BRAIN_ROOT: opts.noRepos ? join(root, "empty") : join(root, "repos"),
    PR_BRAIN_ENV_FILE: join(root, ".env"),
    PR_BRAIN_OWNER: "owner",
    // These pin the Claude engine; the default engine is agy (pr-brain-agy.test.ts).
    PR_BRAIN_ENGINE: "claude",
    QA_APP_ROOT: opts.appGate ? join(root, "founderos") : join(root, "no-founderos"),
    FAKE_PREFLIGHT: opts.preflight,
    FAKE_GATE: opts.gate ?? "done",
    FAKE_GATE_RC: String(opts.gateRc ?? 0),
    FAKE_HEAD: opts.head ?? "aaaa1111",
    FAKE_PRS: opts.prs ?? `56 ${opts.head ?? "aaaa1111"}`,
    FAKE_COMMENTS: opts.comments ?? "",
    CLAUDE_CALLS: claudeCalls,
    SENDS: sends,
  };
  spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 30_000 });
}

function telegramSends(): string[] {
  if (!existsSync(sends)) return [];
  return readFileSync(sends, "utf8").split("\n@@\n").filter((s) => s.trim() !== "");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-brain-"));
  home = join(root, "home");
  bin = join(root, "bin");
  repo = join(root, "repos", "oplify-messaging-api");
  sends = join(root, "sends.log");
  claudeCalls = join(root, "claude-calls.log");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");

  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/oplify-messaging-api.git"], { cwd: repo });

  // Preflight is the only call whose prompt asks for "ok". Every call is counted:
  // each one is a Claude session billed against the account's usage limit.
  // Like the real CLI, it reads piped stdin into the prompt — inside the sweep's
  // \`while read … done <<<"$prs"\` loop that would swallow the next PR's line.
  stub(
    "claude",
    `[ -t 0 ] || cat >/dev/null
echo call >>"$CLAUDE_CALLS"
case "$*" in
  *"reply with the single word ok"*) printf '%s\\n' "$FAKE_PREFLIGHT"; exit 0 ;;
  *) printf '%s\\n' "$FAKE_GATE"; exit "$FAKE_GATE_RC" ;;
esac`,
  );
  stub(
    "gh",
    `case "$*" in
  "api user"*) echo owner ;;
  "auth status"*) exit 0 ;;
  "pr list"*) [ -n "$FAKE_PRS" ] && echo "$FAKE_PRS" ;;
  *"headRefOid"*) echo "$FAKE_HEAD" ;;
  *"--json comments"*) echo "$FAKE_COMMENTS" ;;
  *"reviewDecision"*) echo "CLEARED — marked ready · title" ;;
  *"baseRefName"*) echo main ;;
  *"--json url"*) echo "https://github.com/owner/oplify-messaging-api/pull/56" ;;
  *) exit 0 ;;
esac`,
  );
  // Every Telegram send lands here; nothing reaches the network.
  stub(
    "curl",
    `for a in "$@"; do case "$a" in
  text=*) printf '%s\\n@@\\n' "\${a#text=}" >>"$SENDS" ;;
  caption=*) printf 'PHOTO %s\\n@@\\n' "\${a#caption=}" >>"$SENDS" ;;
esac; done; exit 0`,
  );

  // The app (browser) gate: pr-brain runs `timeout <sec> node … qa-app.ts … --out <dir>`.
  // This stands in for it — writes a report and two screenshots, exits 0 (clean).
  mkdirSync(join(root, "founderos", "scripts"), { recursive: true });
  writeFileSync(join(root, "founderos", "scripts", "qa-app.ts"), "");
  stub(
    "timeout",
    `out=""; while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done
mkdir -p "$out/screenshots"; echo "## App Evidence Pack" >"$out/report.md"
: >"$out/screenshots/a-login.png"; : >"$out/screenshots/b-home.png"; exit 0`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pr-brain — Claude outage", () => {
  it("sends ONE message across repeated sweeps while Claude is over its usage limit", () => {
    for (let i = 0; i < 5; i++) sweep({ preflight: LIMIT_MSG });

    const msgs = telegramSends();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/paused/i);
    expect(msgs[0]).toContain("limit");
  });

  it("dispatches no gate while the preflight fails", () => {
    sweep({ preflight: LIMIT_MSG, gate: "SHOULD NOT RUN" });
    const log = readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");
    expect(log).not.toContain("SHOULD NOT RUN");
    expect(log).not.toMatch(/gating oplify-messaging-api#56/);
  });

  it("sends ONE resume message when Claude comes back, then none on the next healthy sweep", () => {
    sweep({ preflight: LIMIT_MSG });
    sweep({ preflight: LIMIT_MSG });
    sweep({ preflight: "ok" });
    const afterRecovery = telegramSends();
    // paused, resumed, and the normal "Gate done" for the PR that finally ran
    expect(afterRecovery.filter((m) => /resumed/i.test(m))).toHaveLength(1);

    sweep({ preflight: "ok", head: "bbbb2222" });
    expect(telegramSends().filter((m) => /resumed|paused/i.test(m))).toHaveLength(2);
  });

  it("treats a limit hit MID-sweep as an outage: one paused message, sweep stops", () => {
    sweep({ preflight: "ok", gate: LIMIT_MSG, gateRc: 1 });
    sweep({ preflight: "ok", gate: LIMIT_MSG, gateRc: 1 });
    sweep({ preflight: "ok", gate: LIMIT_MSG, gateRc: 1 });

    const msgs = telegramSends();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/paused/i);
    expect(msgs.join("\n")).not.toContain("Gate FAILED");
  });

  it("treats the preflight's own budget cap as reachable, not as an outage", () => {
    // 2026-09-28 06:20, production: the one-word preflight costs more than its
    // $0.05 cap (Claude Code's context loads first), so it prints this instead of
    // "ok". A billed call proves auth and quota are fine.
    sweep({ preflight: "Error: Exceeded USD budget (0.05)" });

    const log = readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");
    expect(log).toMatch(/gating oplify-messaging-api#56/);
    expect(telegramSends().filter((m) => /paused/i.test(m))).toHaveLength(0);
  });

  it("keeps the auth-expired message actionable", () => {
    sweep({ preflight: "Invalid API key · Please run /login" });
    sweep({ preflight: "Invalid API key · Please run /login" });
    const msgs = telegramSends();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("/login");
  });
});

describe("pr-brain — one PR whose gate keeps failing", () => {
  it("announces the first failure and the give-up, and nothing in between", () => {
    for (let i = 0; i < 6; i++) sweep({ preflight: "ok", gate: "Error: something broke", gateRc: 1 });

    const msgs = telegramSends();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("Gate FAILED");
    expect(msgs[1]).toMatch(/gave up/i);
  });

  it("stops re-running a head it has given up on, and a new push re-opens it", () => {
    for (let i = 0; i < 4; i++) sweep({ preflight: "ok", gate: "Error: something broke", gateRc: 1 });
    const log = readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");
    expect(log.match(/gating oplify-messaging-api#56/g)).toHaveLength(3);

    sweep({ preflight: "ok", head: "cccc3333" });
    expect(telegramSends().at(-1)).toContain("Gate done");
  });
});

describe("pr-brain — app-gate screenshots (issue #730)", () => {
  it("sends a head's screenshots once, even when its gate is retried", () => {
    for (let i = 0; i < 3; i++) {
      sweep({ preflight: "ok", gate: "Error: something broke", gateRc: 1, appGate: true });
    }
    expect(telegramSends().filter((m) => m.startsWith("PHOTO"))).toHaveLength(2);
  });

  it("sends screenshots again for a new head", () => {
    sweep({ preflight: "ok", appGate: true });
    sweep({ preflight: "ok", appGate: true, head: "dddd4444" });
    expect(telegramSends().filter((m) => m.startsWith("PHOTO"))).toHaveLength(4);
  });
});

describe("pr-brain — Claude is called on demand only", () => {
  // 2026-09-28: the preflight ran on every 20-minute tick, before the sweep looked
  // for work — 72 Claude sessions a day on a box whose PR queue was empty most of
  // the day, on an account that hit its usage limit the same morning.
  const claudeCallCount = () =>
    existsSync(claudeCalls) ? readFileSync(claudeCalls, "utf8").split("\n").filter(Boolean).length : 0;

  it("makes no Claude call when no PR is open", () => {
    for (let i = 0; i < 3; i++) sweep({ preflight: "ok", prs: "" });
    expect(claudeCallCount()).toBe(0);
  });

  it("makes no Claude call when every open PR is already gated at its head", () => {
    sweep({ preflight: "ok", comments: "<!-- brain-reviewed: aaaa1111 -->" });
    expect(claudeCallCount()).toBe(0);
  });

  it("preflights once, then gates, when a PR is waiting", () => {
    sweep({ preflight: "ok" });
    expect(claudeCallCount()).toBe(2);
    const log = readFileSync(join(home, ".claude", "pr-brain.log"), "utf8");
    expect(log).toMatch(/gating oplify-messaging-api#56/);
  });

  it("preflights once per sweep, however many PRs it gates", () => {
    sweep({ preflight: "ok", prs: "56 aaaa1111\n57 aaaa1111" });
    // one preflight + one gate per PR
    expect(claudeCallCount()).toBe(3);
  });

  it("does not announce 'resumed' from a root with no repositories", () => {
    sweep({ preflight: LIMIT_MSG });
    mkdirSync(join(root, "empty"), { recursive: true });
    sweep({ preflight: "ok", noRepos: true });
    expect(telegramSends().filter((m) => /resumed/i.test(m))).toHaveLength(0);
  });

  it("does not announce 'resumed' while paused if no PR needed Claude", () => {
    sweep({ preflight: LIMIT_MSG });
    sweep({ preflight: "ok", prs: "" });
    expect(telegramSends().filter((m) => /resumed/i.test(m))).toHaveLength(0);
    expect(existsSync(join(home, ".claude", "pr-brain.down"))).toBe(true);

    // The next sweep that has work checks Claude for real, and only then resumes.
    sweep({ preflight: "ok" });
    expect(telegramSends().filter((m) => /resumed/i.test(m))).toHaveLength(1);
  });
});
