/**
 * Telegram quiet hours helper — deploy/lib/tg-quiet.sh.
 * ======================================================
 * Quiet hours (23:00-08:00 IST) hold all non-emergency Telegram messages into
 * $HOME/.claude/tg-digest.queue and flush them as one morning digest on the
 * first run after 08:00 IST.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../../../deploy/lib/tg-quiet.sh", import.meta.url));

let root: string;
let home: string;
let stubs: string;

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(body: string, env: Record<string, string> = {}): Ran {
  const script = `
set -uo pipefail
mkdir -p "$HOME/.claude"
source "${LIB}"
${body}
`;
  const r = spawnSync("bash", ["-c", script], {
    env: {
      PATH: `${stubs}:/usr/bin:/bin:/usr/local/bin`,
      HOME: home,
      ENV_FILE: join(root, ".env"),
      SENDS_LOG: join(root, "sends.txt"),
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const sends = (): string[] =>
  existsSync(join(root, "sends.txt"))
    ? readFileSync(join(root, "sends.txt"), "utf8").split("\n@@\n").filter((s) => s.trim() !== "")
    : [];

const queueFile = () => join(home, ".claude", "tg-digest.queue");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tg-quiet-"));
  home = join(root, "home");
  stubs = join(root, "stubs");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(stubs, { recursive: true });

  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=token123\nTELEGRAM_CHAT_ID=chat123\n");

  // Stub curl to capture Telegram sends
  writeFileSync(
    join(stubs, "curl"),
    `#!/usr/bin/env bash
if [[ "\${FAIL_CURL:-0}" -eq 1 ]]; then
  exit 1
fi
for a in "$@"; do
  case "$a" in
    text=*) printf '%s\\n@@\\n' "\${a#text=}" >>"$SENDS_LOG" ;;
  esac
done
exit 0
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("tg_is_quiet — window edges", () => {
  it("evaluates default 23-08 window correctly", () => {
    expect(run("tg_is_quiet", { TG_QUIET_NOW: "22" }).status).toBe(1);
    expect(run("tg_is_quiet", { TG_QUIET_NOW: "23" }).status).toBe(0);
    expect(run("tg_is_quiet", { TG_QUIET_NOW: "00" }).status).toBe(0);
    expect(run("tg_is_quiet", { TG_QUIET_NOW: "07" }).status).toBe(0);
    expect(run("tg_is_quiet", { TG_QUIET_NOW: "08" }).status).toBe(1);
  });

  it("evaluates custom TG_QUIET_HOURS window", () => {
    expect(run("tg_is_quiet", { TG_QUIET_HOURS: "01-05", TG_QUIET_NOW: "03" }).status).toBe(0);
    expect(run("tg_is_quiet", { TG_QUIET_HOURS: "01-05", TG_QUIET_NOW: "06" }).status).toBe(1);
  });
});

describe("tg_hold — queueing messages", () => {
  it("appends formatted entry to tg-digest.queue", () => {
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate done — oplify#56\nsecond line"`);
    expect(existsSync(queueFile())).toBe(true);

    const content = readFileSync(queueFile(), "utf8").trim();
    const parts = content.split("\t");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(parts[1]).toBe("pr-brain");
    expect(parts[2]).toBe("Gate done — oplify#56");
  });

  it("collapses whitespace and limits text length to 300 characters", () => {
    const longText = "a ".repeat(200);
    run(`TG_DAEMON_NAME=agent-dispatch tg_hold "  ${longText}  "`);

    const content = readFileSync(queueFile(), "utf8").trim();
    const text = content.split("\t")[2] ?? "";
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toMatch(/\s{2,}/);
  });
});

describe("tg_flush_digest — delivering digest", () => {
  it("does not flush during quiet hours", () => {
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate done"`);
    const r = run("tg_flush_digest", { TG_QUIET_NOW: "02" });

    expect(r.status).toBe(0);
    expect(sends()).toHaveLength(0);
    expect(existsSync(queueFile())).toBe(true);
  });

  it("flushes and groups identical entries when not quiet", () => {
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate FAILED — oplify#56"`, { TG_QUIET_NOW: "02" });
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate FAILED — oplify#56"`, { TG_QUIET_NOW: "03" });
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate done — oplify#57"`, { TG_QUIET_NOW: "04" });

    const r = run("tg_flush_digest", { TG_QUIET_NOW: "09" });
    expect(r.status).toBe(0);

    const s = sends();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain("🌅 Overnight digest (3 events)");
    expect(s[0]).toContain("Gate FAILED — oplify#56 ×2");
    expect(s[0]).toContain("Gate done — oplify#57");
    expect(existsSync(queueFile())).toBe(false);
  });

  it("handles double flush atomically: second flush finds queue gone and sends nothing", () => {
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate done"`);

    run("tg_flush_digest; tg_flush_digest", { TG_QUIET_NOW: "09" });

    expect(sends()).toHaveLength(1);
  });

  it("preserves queue when telegram send fails", () => {
    run(`TG_DAEMON_NAME=pr-brain tg_hold "Gate done"`);

    const r = run("tg_flush_digest", { TG_QUIET_NOW: "09", FAIL_CURL: "1" });
    expect(r.status).toBe(1);

    expect(sends()).toHaveLength(0);
    expect(existsSync(queueFile())).toBe(true);
    expect(readFileSync(queueFile(), "utf8")).toContain("Gate done");
  });
});
