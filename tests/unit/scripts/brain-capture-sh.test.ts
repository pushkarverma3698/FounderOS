/**
 * Mac wrapper + installer (AG-027), run for real with a fake `ssh` and a fake HOME. Linux CI is authoritative:
 * these shell out to bash.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const WRAPPER = join(REPO, "scripts/mac/brain-capture.sh");
const INSTALLER = join(REPO, "scripts/mac/install-brain-capture.sh");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bc-sh-"));
  mkdirSync(join(home, ".claude", "projects", "p", "memory"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "p", "memory", "one.md"), "a durable fact");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeSsh(exitCode: number): string {
  const path = join(home, "fake-ssh.sh");
  writeFileSync(path, `#!/bin/bash\ncat > "${home}/received.jsonl"\necho "ingested 1, skipped 0, archived 0, dropped-for-secrets 0"\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

const runWrapper = (sshExit: number) =>
  spawnSync("bash", [WRAPPER], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, BRAIN_CAPTURE_REPO: REPO, BRAIN_CAPTURE_SSH: fakeSsh(sshExit) },
  });

describe("scripts/mac/brain-capture.sh", () => {
  it("sends the digests over ssh and moves the state into place only on success", () => {
    const r = runWrapper(0);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, "received.jsonl"), "utf-8")).toContain("claude_memory");
    expect(existsSync(join(home, ".claude", "brain-capture-state.json"))).toBe(true);
  });

  it("keeps the old state and exits 1 when the VPS ingest fails, so the next run retries", () => {
    const r = runWrapper(1);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("state unchanged");
    expect(existsSync(join(home, ".claude", "brain-capture-state.json"))).toBe(false);
  });
});

describe("scripts/mac/install-brain-capture.sh", () => {
  it("renders the plist with the repo path and a 1800 s interval", () => {
    const r = spawnSync("bash", [INSTALLER], {
      encoding: "utf-8", env: { ...process.env, INSTALL_HOME: home, INSTALL_SKIP_LAUNCHCTL: "1", PATH: `${join(home, "bin")}:${process.env["PATH"]}` },
    });
    expect(r.status).toBe(0);
    const plist = readFileSync(join(home, "Library/LaunchAgents/com.founderos.brain-capture.plist"), "utf-8");
    expect(plist).toContain(`${REPO}/scripts/mac/brain-capture.sh`);
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).not.toContain("__REPO__");
    expect(plist).not.toContain("__HOME__");
  });

  it("removes only the brain-auto-ingest crontab line, after backing the crontab up", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const store = join(home, "crontab.txt");
    writeFileSync(store, "0 2 * * * /x/brain-auto-ingest.sh\n*/5 * * * * /x/keep-me.sh\n");
    writeFileSync(join(bin, "crontab"), `#!/bin/bash\nif [ "$1" = "-l" ]; then cat "${store}"; else cat > "${store}"; fi\n`);
    chmodSync(join(bin, "crontab"), 0o755);

    const r = spawnSync("bash", [INSTALLER], {
      encoding: "utf-8", env: { ...process.env, INSTALL_HOME: home, INSTALL_SKIP_LAUNCHCTL: "1", PATH: `${bin}:${process.env["PATH"]}` },
    });
    expect(r.status).toBe(0);
    const after = readFileSync(store, "utf-8");
    expect(after).not.toContain("brain-auto-ingest");
    expect(after).toContain("keep-me.sh");
    const backups = spawnSync("bash", ["-c", `grep -l brain-auto-ingest "${home}"/.claude/crontab-backup-*.txt`], { encoding: "utf-8" });
    expect(backups.status).toBe(0);
  });
});
