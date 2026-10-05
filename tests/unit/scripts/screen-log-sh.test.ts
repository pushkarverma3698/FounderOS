/**
 * Unit test — tg_screen_log (deploy/lib/tg-quiet.sh), the bash writer of the screen log.
 * Every daemon sources tg-quiet.sh, so this one helper is how pr-brain, agent-dispatch and the agy
 * progress messages reach ~/.claude/screen.jsonl. The node reader (src/infra/screen-log.ts) must
 * parse whatever it writes, and a failed write must never fail the daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readScreen, SCREEN_LOG_MAX_BYTES } from "../../../src/infra/screen-log.js";

const LIB = fileURLToPath(new URL("../../../deploy/lib/tg-quiet.sh", import.meta.url));

let root: string;
let home: string;
let stubs: string;
const screenFile = () => join(home, ".claude", "screen.jsonl");

function run(body: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${LIB}"\n${body}\necho survived`], {
    env: { PATH: `${stubs}:/usr/bin:/bin:/usr/local/bin`, HOME: home, TG_DAEMON_NAME: "agent-dispatch", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "screen-sh-"));
  home = join(root, "home");
  stubs = join(root, "stubs");
  mkdirSync(stubs, { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe("tg_screen_log", () => {
  it("writes a line the node reader parses, whatever the text contains", async () => {
    const text = `🛑 owner/oplify-api #76/PR #79 "blocked" — 3 attempts\nline 2 with \\ backslash, $HOME and 'quotes'`;
    writeFileSync(join(root, "msg.txt"), text);
    const r = run(`tg_screen_log "$(cat "${join(root, "msg.txt")}")" 111`);
    expect(r.stdout).toContain("survived");
    expect(r.stderr).toBe(""); // the first write (no file yet) must not leave noise in the daemon's log
    const got = await readScreen("111", new Date(), { file: screenFile() });
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe(text);
    expect(got[0]!.src).toBe("agent-dispatch");
    expect(Math.abs(Date.parse(got[0]!.ts) - Date.now())).toBeLessThan(60_000);
  });

  it("records a numeric message id so a later edit replaces the text", async () => {
    run(`tg_screen_log "🔧 starting…" 111 42; tg_screen_log "🔧 done" 111 42`);
    const got = await readScreen("111", new Date(), { file: screenFile() });
    expect(got.map((e) => [e.text, e.mid])).toEqual([["🔧 done", 42]]);
  });

  it("drops a message id that is not a number instead of writing a bad line", async () => {
    run(`tg_screen_log "hello" 111 "not-a-number"`);
    const raw = JSON.parse(readFileSync(screenFile(), "utf8").trim()) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("mid");
    expect(raw["text"]).toBe("hello");
  });

  it("writes nothing without a chat id or a text", () => {
    run(`tg_screen_log "" 111; tg_screen_log "text" ""`);
    expect(existsSync(screenFile())).toBe(false);
  });

  it("creates the file readable by its owner only", () => {
    run(`tg_screen_log "private" 111`);
    const mode = spawnSync("bash", ["-c", `ls -l "${screenFile()}"`], { encoding: "utf8" }).stdout;
    expect(mode.startsWith("-rw-------")).toBe(true);
  });

  it("rotates the file past the size cap", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(screenFile(), "x".repeat(SCREEN_LOG_MAX_BYTES + 1));
    run(`tg_screen_log "fresh" 111`);
    expect(existsSync(`${screenFile()}.1`)).toBe(true);
    expect(readFileSync(screenFile(), "utf8")).toContain("fresh");
  });

  it("never fails a daemon running under set -e: broken jq, unwritable home", () => {
    writeFileSync(join(stubs, "jq"), "#!/usr/bin/env bash\nexit 5\n", { mode: 0o755 });
    expect(run(`tg_screen_log "x" 111`).stdout).toContain("survived");
    rmSync(join(stubs, "jq"));
    chmodSync(home, 0o500);
    const r = run(`tg_screen_log "x" 111`);
    expect(r.stdout).toContain("survived");
  });
});
