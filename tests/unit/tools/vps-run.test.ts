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

import { describe, it, expect } from "vitest";
import {
  vpsRunTool,
  validateVpsRunInput,
  buildDockerCommand,
  shellQuote,
  makeRunId,
  resolveVpsRunConfig,
  VPS_RUN_PROFILE,
  FORBIDDEN_MOUNT,
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
    expect(calls[4]!.cmd).toBe("rm -rf /srv/agent-runs/run-test12");
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

describe("resolveVpsRunConfig", () => {
  it("returns null when VPS_RUN_HOST is unset (tool reports vps-config, never guesses)", () => {
    expect(resolveVpsRunConfig({})).toBeNull();
  });

  it("builds config from env with runsRoot default", () => {
    const cfg = resolveVpsRunConfig({ VPS_RUN_HOST: "root@1.2.3.4", VPS_RUN_SSH_KEY: "/k" });
    expect(cfg).toEqual({ host: "root@1.2.3.4", keyPath: "/k", runsRoot: VPS_RUN_PROFILE.runsRoot });
  });
});
