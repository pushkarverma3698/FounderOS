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

function stub(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** One sweep. `preflight`/`gate` are what the fake claude prints for each call. */
function sweep(opts: { preflight: string; gate?: string; gateRc?: number; head?: string }): void {
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: home,
    PR_BRAIN_ROOT: join(root, "repos"),
    PR_BRAIN_ENV_FILE: join(root, ".env"),
    PR_BRAIN_OWNER: "owner",
    QA_APP_ROOT: join(root, "no-founderos"),
    FAKE_PREFLIGHT: opts.preflight,
    FAKE_GATE: opts.gate ?? "done",
    FAKE_GATE_RC: String(opts.gateRc ?? 0),
    FAKE_HEAD: opts.head ?? "aaaa1111",
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
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");

  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/oplify-messaging-api.git"], { cwd: repo });

  // Preflight is the only call whose prompt asks for "ok".
  stub(
    "claude",
    `case "$*" in
  *"reply with the single word ok"*) printf '%s\\n' "$FAKE_PREFLIGHT"; exit 0 ;;
  *) printf '%s\\n' "$FAKE_GATE"; exit "$FAKE_GATE_RC" ;;
esac`,
  );
  stub(
    "gh",
    `case "$*" in
  "api user"*) echo owner ;;
  "auth status"*) exit 0 ;;
  "pr list"*) echo "56 $FAKE_HEAD" ;;
  *"headRefOid"*) echo "$FAKE_HEAD" ;;
  *"--json comments"*) echo "" ;;
  *"reviewDecision"*) echo "CLEARED — marked ready · title" ;;
  *"baseRefName"*) echo main ;;
  *"--json url"*) echo "https://github.com/owner/oplify-messaging-api/pull/56" ;;
  *) exit 0 ;;
esac`,
  );
  // Every Telegram send lands here; nothing reaches the network.
  stub("curl", `for a in "$@"; do case "$a" in text=*) printf '%s\\n@@\\n' "\${a#text=}" >>"$SENDS" ;; esac; done; exit 0`);
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
