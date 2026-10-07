/**
 * Contract — scripts/mac/session-start-digest.sh (AG-029).
 * Runs the real script with a fake `ssh` first on PATH: it must print the digest, remember the run time,
 * resume from that time, and on a hung or failing SSH print one line, exit 0, and keep the old time.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/mac/session-start-digest.sh", import.meta.url));

interface Run {
  readonly stdout: string;
  readonly status: number | null;
  readonly stateFile: string;
  readonly sshArgs: string;
  readonly ms: number;
}

/** `sshBody` is the fake ssh's shell body; it receives the remote command as "$*" and logs it to $SSH_LOG. */
function run(sshBody: string, opts: { cwd?: string; state?: string; timeoutS?: string } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "digest-hook-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env bash\necho "$*" >> "${dir}/ssh.log"\n${sshBody}\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const stateDir = join(dir, "state");
  spawnSync("mkdir", ["-p", stateDir]);
  const stateFile = join(stateDir, "brain-digest-state.json");
  if (opts.state) writeFileSync(stateFile, opts.state);
  const started = Date.now();
  const r = spawnSync("bash", [SCRIPT], {
    cwd: opts.cwd ?? dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: dir,
      CLAUDE_STATE_DIR: stateDir,
      BRAIN_DIGEST_TIMEOUT_S: opts.timeoutS ?? "5",
    },
  });
  const sshArgs = existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8") : "";
  return { stdout: r.stdout, status: r.status, stateFile, sshArgs, ms: Date.now() - started };
}

describe("session-start-digest.sh", () => {
  it("prints the digest, asks for the last 36h on a first run, and records the run time", () => {
    const r = run(`echo "06 Oct 15:30 IST · mac-claude · founderos · did a thing"`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("did a thing");
    expect(r.sshArgs).toContain("--since '36h'");
    expect(readFileSync(r.stateFile, "utf8")).toMatch(/"last_run":"\d{4}-\d{2}-\d{2}T[\d:]+Z"/);
  });
  it("resumes from the stored time and scopes to the cwd's project", () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-proj-"));
    spawnSync("mkdir", ["-p", join(dir, "FounderOS")]);
    const r = run(`echo ok`, { cwd: join(dir, "FounderOS"), state: '{"last_run":"2026-10-05T08:00:00Z"}' });
    expect(r.sshArgs).toContain("--since '2026-10-05T08:00:00Z'");
    expect(r.sshArgs).toContain("--project 'founderos'");
  });
  it("on a hung ssh prints one unavailable line, exits 0 inside the budget, and keeps the old time", () => {
    const old = '{"last_run":"2026-10-05T08:00:00Z"}';
    const r = run(`exec sleep 30`, { state: old, timeoutS: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/digest unavailable \(timed out/);
    expect(r.ms).toBeLessThan(4000);
    expect(readFileSync(r.stateFile, "utf8")).toBe(old);
  });
  it("on a failing ssh prints one unavailable line and exits 0", () => {
    const r = run(`exit 255`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/digest unavailable \(ssh or digest failed\)/);
    expect(existsSync(r.stateFile)).toBe(false);
  });
});
