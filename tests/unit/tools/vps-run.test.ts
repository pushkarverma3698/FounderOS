/**
 * Unit tests for the vps_run tool (spec 2026-07-14 §3.3, follow-up item 11).
 * =============================================================================
 * The SSH runner and S3 uploader are injected fakes — $0, no network, no VPS.
 * Pins the security invariants:
 *   - run_id grammar blocks path traversal into docker -v / S3 keys
 *   - the only mount is {runsRoot}/{run_id}/work; /root/founderos never appears
 *   - image allowlist; network defaults to none; timeout clamped
 * And the ToolResult contract: never throws, failures name the real component,
 * artifacts are harvested even when the container fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as s3Client from "../../../src/infra/storage/s3-client.js";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  vpsRunTool,
  validateVpsRunInput,
  buildDockerCommand,
  shellQuote,
  makeRunId,
  makeSshRunner,
  resolveVpsRunConfig,
  VPS_RUN_PROFILE,
  FORBIDDEN_MOUNT,
  SSH_LOCAL_TIMEOUT_CODE,
  SSH_LOCAL_TIMEOUT_MARK,
  SSH_MAX_STDOUT_BYTES,
  type SshRunner,
  type SshResult,
  type VpsRunData,
  type VpsRunConfig,
} from "../../../src/tools/vps-run.js";
import { WorkspaceHandleSchema, RUN_ID_RE } from "../../../src/kernel/workspace.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

const CFG: VpsRunConfig = { host: "root@vps.test", runsRoot: "/srv/agent-runs" };

interface SshCall {
  cmd: string;
  stdin?: string;
}

/** Scripted SSH fake: matches each remote command by substring, records calls. */
function fakeSsh(script: Array<{ match: string; result: Partial<SshResult> }>, calls: SshCall[] = []): { ssh: SshRunner; calls: SshCall[] } {
  const ssh: SshRunner = (cmd, opts) => {
    calls.push({ cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const hit = script.find((s) => cmd.includes(s.match));
    if (!hit) return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: "" });
    return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: "", ...hit.result });
  };
  return { ssh, calls };
}

function fakeUpload(uploaded: Array<{ filename: string; runId: string; bytes: number }> = []) {
  return {
    uploaded,
    upload: (bytes: Buffer, filename: string, runId: string, prefix: string) => {
      uploaded.push({ filename, runId, bytes: bytes.length });
      return Promise.resolve(`${prefix}/${runId}/uuid_${filename}`);
    },
  };
}

const BASE_ARGS = { command: "node build-report.js", run_id: "run-test12", _configOverride: CFG };

// ── Shape (8-point checklist §1) ──────────────────────────────────────────────

describe("vpsRunTool — shape", () => {
  it("has name 'vps_run' and an execute function", () => {
    expect(vpsRunTool.name).toBe("vps_run");
    expect(typeof vpsRunTool.execute).toBe("function");
  });

  it("input_schema requires only 'command'", () => {
    expect(vpsRunTool.input_schema?.required).toEqual(["command"]);
    expect(vpsRunTool.input_schema?.properties).toHaveProperty("brief");
    expect(vpsRunTool.input_schema?.properties).toHaveProperty("run_id");
  });
});

// ── Pure validation ───────────────────────────────────────────────────────────

describe("validateVpsRunInput", () => {
  it("rejects a missing/empty command with a correctable message", () => {
    const r = validateVpsRunInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/command/);
  });

  it("rejects traversal-shaped run_id (the docker -v / S3 boundary)", () => {
    const r = validateVpsRunInput({ command: "ls", run_id: "../../root/founderos" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/run_id/);
  });

  it("generates a valid run_id when omitted", () => {
    const r = validateVpsRunInput({ command: "ls" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(RUN_ID_RE.test(r.input.run_id)).toBe(true);
  });

  it("rejects images off the pinned allowlist", () => {
    const r = validateVpsRunInput({ command: "ls", image: "evil/miner:latest" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/allowlist/);
  });

  it("defaults network to none and clamps timeout to the profile max", () => {
    const r = validateVpsRunInput({ command: "ls", timeout_minutes: 999 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.network).toBe("none");
      expect(r.input.timeoutMinutes).toBe(VPS_RUN_PROFILE.maxTimeoutMinutes);
    }
  });

  it("makeRunId always satisfies the grammar", () => {
    for (let i = 0; i < 20; i++) expect(RUN_ID_RE.test(makeRunId())).toBe(true);
  });

  it("tolerates hostile arg shapes — circular objects, non-string fields — without throwing", () => {
    const circular: Record<string, unknown> = { command: "ls" };
    circular["self"] = circular;
    circular["run_id"] = 42; // non-string → freshly generated, never coerced
    circular["image"] = { $ne: 1 };
    circular["brief"] = ["not", "a", "string"];
    const r = validateVpsRunInput(circular);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(RUN_ID_RE.test(r.input.run_id)).toBe(true);
      expect(r.input.image).toBe(VPS_RUN_PROFILE.defaultImage);
      expect(r.input.brief).toBeUndefined();
    }
  });

  it("non-finite timeout_minutes (NaN/Infinity) falls back to the default, never NaN seconds", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = validateVpsRunInput({ command: "ls", timeout_minutes: bad });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input.timeoutMinutes).toBe(VPS_RUN_PROFILE.defaultTimeoutMinutes);
    }
  });
});

// ── makeSshRunner transport hardening (audit 2026-07-14) ─────────────────────
// These spawn a REAL child process via a fake `ssh` on PATH — still $0, still
// offline; they pin the three ways a bad connection could take down the host:
// EPIPE crash, hung 'close', unbounded buffering.

function withFakeSsh(script: string): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-ssh-"));
  writeFileSync(join(dir, "ssh"), script);
  chmodSync(join(dir, "ssh"), 0o755);
  const oldPath = process.env["PATH"];
  process.env["PATH"] = `${dir}:${oldPath ?? ""}`;
  return { restore: () => void (process.env["PATH"] = oldPath) };
}

describe("makeSshRunner — connection failure hardening", () => {
  const RUNNER_CFG: VpsRunConfig = { host: "root@vps.test", runsRoot: "/srv/agent-runs" };

  it("remote exiting before draining a large stdin (EPIPE) resolves instead of crashing the host", async () => {
    const { restore } = withFakeSsh("#!/bin/sh\nexit 255\n");
    try {
      const run = makeSshRunner(RUNNER_CFG);
      // 1 MiB brief > 64 KiB pipe buffer: the write is mid-flight when ssh dies.
      const res = await run("mkdir -p x && cat > x/BRIEF.md", { stdin: "x".repeat(1024 * 1024), timeoutMs: 10_000 });
      expect(res.code).toBe(255);
    } finally {
      restore();
    }
  });

  it("settles within grace when the kill-timer fires but descendants hold the stdio pipes (ControlMaster class)", async () => {
    const { restore } = withFakeSsh("#!/bin/sh\nsleep 15 &\nwait\n");
    try {
      const run = makeSshRunner(RUNNER_CFG);
      const t0 = Date.now();
      // timeoutMs must comfortably exceed worst-case `sh` startup on a loaded
      // machine: the grace path only exists once the script has forked `sleep`
      // (the pipe-holder). If SIGKILL lands first, 'close' fires immediately and
      // reports code 1 — the wrong scenario. At 500ms that race was lost under
      // full-suite parallel load (2026-07-17); SIGKILL is unblockable, so margin
      // is the only ordering guarantee. Do not lower this below seconds.
      const res = await run("docker run …", { timeoutMs: 3_000 });
      expect(Date.now() - t0).toBeLessThan(12_000); // 3s timeout + 2s grace, generous CI margin
      expect(res.code).toBe(SSH_LOCAL_TIMEOUT_CODE);
      expect(res.stderr).toContain(SSH_LOCAL_TIMEOUT_MARK);
    } finally {
      restore();
    }
  }, 20_000);

  it("runaway remote stdout is tail-trimmed to the cap, not buffered unboundedly", async () => {
    const { restore } = withFakeSsh(`#!/bin/sh\nhead -c 20000000 /dev/zero | tr '\\0' 'a'\n`);
    try {
      const run = makeSshRunner(RUNNER_CFG);
      const res = await run("noisy job", { timeoutMs: 30_000 });
      expect(res.code).toBe(0);
      expect(res.stdout.length).toBeGreaterThan(0);
      expect(res.stdout.length).toBeLessThanOrEqual(SSH_MAX_STDOUT_BYTES);
    } finally {
      restore();
    }
  }, 30_000);
});

// ── Docker command construction ───────────────────────────────────────────────

describe("buildDockerCommand", () => {
  const input = validateVpsRunInput({ command: `echo "hi" && touch out.txt`, run_id: "run-test12" });
  const cmd = input.ok ? buildDockerCommand(input.input, CFG.runsRoot) : "";

  it("mounts ONLY the run's work dir and never the live checkout", () => {
    expect(cmd).toContain("-v /srv/agent-runs/run-test12/work:/work");
    expect(cmd.match(/-v /g)).toHaveLength(1);
    expect(cmd).not.toContain(FORBIDDEN_MOUNT);
  });

  it("applies the pinned resource profile and no-network default", () => {
    expect(cmd).toContain("--network=none");
    expect(cmd).toContain(`--memory=${VPS_RUN_PROFILE.memory}`);
    expect(cmd).toContain(`--cpus=${VPS_RUN_PROFILE.cpus}`);
    expect(cmd).toContain(`--pids-limit=${VPS_RUN_PROFILE.pidsLimit}`);
    expect(cmd).toContain("--rm");
  });

  it("bounds the run with remote `timeout` from the clamped minutes", () => {
    expect(cmd).toMatch(/^timeout 600s docker run/);
  });

  it("throws (defense-in-depth) if a hostile runsRoot targets the checkout", () => {
    const ok = validateVpsRunInput({ command: "ls", run_id: "run-test12" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(() => buildDockerCommand(ok.input, "/root/founderos")).toThrow(/refusing/);
  });

  it("shellQuote survives embedded single quotes", () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
});

// ── execute(): happy path ─────────────────────────────────────────────────────

describe("vpsRunTool.execute — happy path", () => {
  it("preps, runs, harvests, cleans up — in that order — and returns a valid WorkspaceHandle", async () => {
    const { ssh, calls } = fakeSsh([
      { match: "docker run", result: { code: 0, stdout: Buffer.from("built report\n") } },
      { match: "find work", result: { code: 0, stdout: Buffer.from("work/report.pdf\n") } },
      { match: "cat ", result: { code: 0, stdout: Buffer.from("PDFBYTES") } },
    ]);
    const { upload, uploaded } = fakeUpload();

    const res = await vpsRunTool.execute({ ...BASE_ARGS, brief: "Overnight report", _ssh: ssh, _upload: upload });

    expect(res.success).toBe(true);
    const data = res.data as VpsRunData;
    expect(data.exit_code).toBe(0);
    expect(data.stdout_tail).toContain("built report");
    expect(data.artifacts).toEqual([{ path: "work/report.pdf", s3_key: "agent-runs/run-test12/uuid_report.pdf", bytes: 8 }]);
    expect(WorkspaceHandleSchema.safeParse(data.workspace).success).toBe(true);
    expect(data.workspace.s3_prefix).toBe("agent-runs/run-test12");

    // Order: mkdir+brief → docker → find → cat → rm
    expect(calls[0]!.cmd).toContain("mkdir -p /srv/agent-runs/run-test12/work");
    expect(calls[0]!.stdin).toBe("Overnight report");
    expect(calls[1]!.cmd).toContain("docker run");
    expect(calls[2]!.cmd).toContain("find work");
    expect(calls[3]!.cmd).toContain("cat ");
    // Cleanup reaps a possibly-orphaned container BEFORE removing the sandbox
    // (killing the docker CLI over a dead SSH link does not stop the container).
    expect(calls[4]!.cmd).toBe("docker rm -f agent-run-run-test12 >/dev/null 2>&1; rm -rf /srv/agent-runs/run-test12");
    expect(uploaded).toHaveLength(1);
  });
});

// ── execute(): failure paths (soft-failure rules, checklist §2/§3) ────────────

describe("vpsRunTool.execute — failures name the real component", () => {
  it("unconfigured (no VPS_RUN_HOST) → success:false naming vps-config", async () => {
    const res = await vpsRunTool.execute({ command: "ls", _configOverride: null as unknown as VpsRunConfig });
    // _configOverride null → falls back to resolveVpsRunConfig(process.env); guard the test env:
    if (!process.env["VPS_RUN_HOST"]) {
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/vps-config/);
    }
  });

  it("ssh transport error → success:false naming vps-ssh, never throws", async () => {
    const ssh: SshRunner = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh, _upload: fakeUpload().upload });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vps-ssh/);
  });

  it("sandbox prep failure → success:false, docker never invoked", async () => {
    const { ssh, calls } = fakeSsh([{ match: "mkdir -p", result: { code: 1, stderr: "disk full" } }]);
    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh, _upload: fakeUpload().upload });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vps-ssh.*disk full/s);
    expect(calls.some((c) => c.cmd.includes("docker run"))).toBe(false);
  });

  it("container non-zero exit → success:false naming vps-docker, but artifacts STILL harvested", async () => {
    const { ssh } = fakeSsh([
      { match: "docker run", result: { code: 2, stdout: Buffer.from("partial"), stderr: "script blew up" } },
      { match: "find work", result: { code: 0, stdout: Buffer.from("work/error.log\n") } },
      { match: "cat ", result: { code: 0, stdout: Buffer.from("LOG") } },
    ]);
    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh, _upload: fakeUpload().upload });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vps-docker.*exited 2/s);
    const data = res.data as VpsRunData;
    expect(data.artifacts).toHaveLength(1);
    expect(data.artifacts[0]!.s3_key).toContain("error.log");
  });

  it("remote `timeout` kill (exit 124) is reported as a timeout", async () => {
    const { ssh } = fakeSsh([
      { match: "docker run", result: { code: 124 } },
      { match: "find work", result: { code: 0, stdout: Buffer.alloc(0) } },
    ]);
    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh, _upload: fakeUpload().upload });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out after/);
  });

  it("artifact upload failure → success:false naming vps-artifacts (job ran, handoff didn't)", async () => {
    const { ssh } = fakeSsh([
      { match: "docker run", result: { code: 0 } },
      { match: "find work", result: { code: 0, stdout: Buffer.from("work/out.bin\n") } },
      { match: "cat ", result: { code: 0, stdout: Buffer.from("DATA") } },
    ]);
    const upload = () => Promise.reject(new Error("S3 bucket unreachable"));
    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh, _upload: upload });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vps-artifacts.*S3 bucket unreachable/s);
  });

  it("cleanup failure does NOT fail an otherwise-green run (artifacts already durable)", async () => {
    const { ssh } = fakeSsh([
      { match: "docker run", result: { code: 0, stdout: Buffer.from("ok") } },
      { match: "find work", result: { code: 0, stdout: Buffer.alloc(0) } },
      { match: "rm -rf", result: { code: 1, stderr: "busy" } },
    ]);
    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh, _upload: fakeUpload().upload });
    expect(res.success).toBe(true);
  });
});

describe("vps_run — s3-isolated mode", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.VPS_RUN_MODE;
    process.env.VPS_RUN_MODE = "s3-isolated";
    process.env.STORAGE_BUCKET = "test-bucket";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.VPS_RUN_MODE = originalMode;
  });

  it("stages BRIEF.md to S3, executes docker command without volume mounts, and lists outputs from S3", async () => {
    const stageSpy = vi.spyOn(s3Client, "stageFile").mockResolvedValue("agent-runs/run-test12/brief.md");
    const listSpy = vi.spyOn(s3Client, "listFiles").mockResolvedValue(["agent-runs/run-test12/outputs/hello.png"]);
    const downloadSpy = vi.spyOn(s3Client, "downloadFile").mockResolvedValue(Buffer.from("IMAGE_BYTES"));

    const { ssh, calls } = fakeSsh([
      { match: "docker run", result: { code: 0, stdout: Buffer.from("container run complete") } },
    ]);

    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh });

    expect(res.success).toBe(true);
    expect(stageSpy).toHaveBeenCalledWith(expect.any(Buffer), "BRIEF.md", "run-test12");
    expect(listSpy).toHaveBeenCalledWith("agent-runs/run-test12/outputs/");
    expect(downloadSpy).toHaveBeenCalledWith("agent-runs/run-test12/outputs/hello.png");

    const dockerCall = calls.find((c) => c.cmd.includes("docker run"));
    expect(dockerCall).toBeDefined();
    expect(dockerCall!.cmd).not.toContain("-v ");
    expect(dockerCall!.cmd).toContain("-e STORAGE_BUCKET=");
    expect(dockerCall!.cmd).toContain("founderos-runner:latest");

    const data = res.data as VpsRunData;
    expect(data.artifacts).toHaveLength(1);
    expect(data.artifacts[0]).toEqual({
      path: "outputs/hello.png",
      s3_key: "agent-runs/run-test12/outputs/hello.png",
      bytes: 11,
    });
  });

  it("handles staging failures gracefully", async () => {
    vi.spyOn(s3Client, "stageFile").mockRejectedValue(new Error("S3 staging failed"));
    const { ssh } = fakeSsh([]);

    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vps-ssh.*S3 staging failed/s);
  });

  it("handles empty outputs gracefully", async () => {
    vi.spyOn(s3Client, "stageFile").mockResolvedValue("key");
    vi.spyOn(s3Client, "listFiles").mockResolvedValue([]);

    const { ssh } = fakeSsh([{ match: "docker run", result: { code: 0 } }]);

    const res = await vpsRunTool.execute({ ...BASE_ARGS, _ssh: ssh });
    expect(res.success).toBe(true);
    const data = res.data as VpsRunData;
    expect(data.artifacts).toHaveLength(0);
  });
});

describe("resolveVpsRunConfig", () => {
  it("returns null when VPS_RUN_HOST is unset (tool reports vps-config, never guesses)", () => {
    expect(resolveVpsRunConfig({})).toBeNull();
  });

  it("builds config from env with runsRoot default", () => {
    const cfg = resolveVpsRunConfig({ VPS_RUN_HOST: "root@1.2.3.4", VPS_RUN_SSH_KEY: "/k" });
    expect(cfg).toEqual({ host: "root@1.2.3.4", keyPath: "/k", runsRoot: VPS_RUN_PROFILE.runsRoot });
  });
});
