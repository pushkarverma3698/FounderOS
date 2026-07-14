/**
 * FounderOS — VPS containerized job runner (spec 2026-07-14 §3.3, follow-up item 11)
 * ====================================================================================
 * Runs one founder-approved command inside an ephemeral Docker container on the
 * VPS and hands the outputs off by-reference through S3. This is the third
 * workspace stratum: state stays in the checkpointer, artifacts in S3
 * run-prefixes — this tool provides the execution sandbox on the always-on box.
 *
 * Flow (each step is a separate SSH exec so nothing is quoted-into-a-script):
 *   1. mkdir {runsRoot}/{run_id}/work + write BRIEF.md (brief travels on stdin)
 *   2. docker run --rm … -v {runsRoot}/{run_id}/work:/work  (bounded by `timeout`)
 *   3. find + cat small output files → upload each to S3 agent-runs/{run_id}/
 *   4. rm -rf the run dir (fail-open: artifacts already durable in S3)
 *
 * SECURITY INVARIANTS (unit-pinned in tests/unit/tools/vps-run.test.ts):
 *   - run_id grammar (kernel RUN_ID_RE) is the traversal boundary — no dots or
 *     slashes can ever reach a path or S3 key.
 *   - The ONLY volume mount is {runsRoot}/{run_id}/work; mounting the live
 *     FounderOS checkout (/root/founderos) is structurally impossible and
 *     additionally hard-asserted (the 2026-06-09 incident class, VPS edition).
 *   - Image must be on the pinned allowlist; network default is none.
 *   - HITL approval happens in the agent wrapper BEFORE execute() is reached.
 *
 * Never throws: every failure returns { success:false, error } naming the real
 * failing component (vps-config | vps-ssh | vps-docker | vps-artifacts).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { RUN_ID_RE, WorkspaceHandleSchema, type WorkspaceHandle } from "../kernel/workspace.js";
import { uploadFile } from "../infra/storage/s3-client.js";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:vps-run" });

// ── Pinned container profile (change HERE, nowhere else) ─────────────────────

export const VPS_RUN_PROFILE = {
  imageAllowlist: ["node:22-bookworm-slim", "python:3.12-slim", "ubuntu:24.04"],
  defaultImage: "node:22-bookworm-slim",
  memory: "2g",
  cpus: "2",
  pidsLimit: 256,
  /** "none" (default) for pure compute; "bridge" for research jobs that fetch. */
  networks: ["none", "bridge"] as const,
  defaultNetwork: "none" as const,
  runsRoot: "/srv/agent-runs",
  defaultTimeoutMinutes: 10,
  maxTimeoutMinutes: 30,
  maxArtifacts: 20,
  maxArtifactBytes: 10 * 1024 * 1024,
  stdoutTailChars: 4_000,
} as const;

/** The live process's checkout — must never appear in any docker argument. */
export const FORBIDDEN_MOUNT = "/root/founderos";

// ── Config (env resolved per call so tests can inject) ───────────────────────

export interface VpsRunConfig {
  /** e.g. "root@95.217.162.12" */
  host: string;
  /** ssh -i path; omitted → ssh uses its default identity. */
  keyPath?: string;
  runsRoot: string;
}

export function resolveVpsRunConfig(env: Record<string, string | undefined> = process.env): VpsRunConfig | null {
  const host = env["VPS_RUN_HOST"]?.trim();
  if (!host) return null;
  const keyPath = env["VPS_RUN_SSH_KEY"]?.trim();
  return {
    host,
    ...(keyPath ? { keyPath } : {}),
    runsRoot: env["VPS_RUN_RUNS_ROOT"]?.trim() || VPS_RUN_PROFILE.runsRoot,
  };
}

// ── Pure input validation + command construction (unit-tested) ────────────────

export interface VpsRunInput {
  command: string;
  run_id: string;
  image: string;
  network: (typeof VPS_RUN_PROFILE.networks)[number];
  timeoutMinutes: number;
  brief?: string;
}

export function makeRunId(): string {
  return `run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Validate raw args into a typed input, or return the correctable error. */
export function validateVpsRunInput(
  args: Record<string, unknown>,
): { ok: true; input: VpsRunInput } | { ok: false; error: string } {
  const command = typeof args["command"] === "string" ? args["command"].trim() : "";
  if (!command) return { ok: false, error: "vps_run needs a non-empty 'command' to execute in the container." };

  const runId = typeof args["run_id"] === "string" && args["run_id"] ? args["run_id"] : makeRunId();
  if (!RUN_ID_RE.test(runId)) {
    return { ok: false, error: `run_id "${runId}" is invalid — lowercase alphanumerics/hyphens, 4-64 chars (it becomes a path and S3 key segment).` };
  }

  const image = typeof args["image"] === "string" && args["image"] ? args["image"] : VPS_RUN_PROFILE.defaultImage;
  if (!(VPS_RUN_PROFILE.imageAllowlist as readonly string[]).includes(image)) {
    return { ok: false, error: `image "${image}" is not on the pinned allowlist: ${VPS_RUN_PROFILE.imageAllowlist.join(", ")}` };
  }

  const network = args["network"] === "bridge" ? "bridge" : VPS_RUN_PROFILE.defaultNetwork;

  const rawTimeout = typeof args["timeout_minutes"] === "number" ? args["timeout_minutes"] : VPS_RUN_PROFILE.defaultTimeoutMinutes;
  const timeoutMinutes = Math.min(Math.max(1, Math.round(rawTimeout)), VPS_RUN_PROFILE.maxTimeoutMinutes);

  const brief = typeof args["brief"] === "string" && args["brief"].trim() ? args["brief"] : undefined;
  return { ok: true, input: { command, run_id: runId, image, network, timeoutMinutes, ...(brief ? { brief } : {}) } };
}

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the remote `docker run` command line (one string for the remote shell).
 * Pure; throws only on the structurally-impossible forbidden mount, which the
 * run_id grammar already prevents — the assert is defense-in-depth.
 */
export function buildDockerCommand(input: VpsRunInput, runsRoot: string): string {
  const workDir = `${runsRoot}/${input.run_id}/work`;
  if (workDir.includes(FORBIDDEN_MOUNT)) {
    throw new Error(`refusing to mount ${FORBIDDEN_MOUNT}`);
  }
  const parts = [
    "timeout", `${input.timeoutMinutes * 60}s`,
    "docker", "run", "--rm",
    "--name", `agent-run-${input.run_id}`,
    `--network=${input.network}`,
    `--memory=${VPS_RUN_PROFILE.memory}`,
    `--cpus=${VPS_RUN_PROFILE.cpus}`,
    `--pids-limit=${VPS_RUN_PROFILE.pidsLimit}`,
    "-v", `${workDir}:/work`,
    "-w", "/work",
    input.image,
    "bash", "-lc", shellQuote(input.command),
  ];
  return parts.join(" ");
}

// ── SSH seam (injected in tests; spawns the real client in production) ────────

export interface SshResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}
export type SshRunner = (remoteCommand: string, opts?: { stdin?: string; timeoutMs?: number }) => Promise<SshResult>;

export function makeSshRunner(cfg: VpsRunConfig): SshRunner {
  return (remoteCommand, opts = {}) =>
    new Promise((resolve, reject) => {
      const args = [
        ...(cfg.keyPath ? ["-i", cfg.keyPath] : []),
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        cfg.host,
        remoteCommand,
      ];
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
      });
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
}

export type ArtifactUploader = (bytes: Buffer, filename: string, runId: string, prefix: string) => Promise<string>;

// ── Result shape ──────────────────────────────────────────────────────────────

export interface VpsRunArtifact {
  path: string;
  s3_key: string;
  bytes: number;
}

export interface VpsRunData {
  run_id: string;
  exit_code: number;
  stdout_tail: string;
  artifacts: VpsRunArtifact[];
  workspace: WorkspaceHandle;
}

// ── The tool ──────────────────────────────────────────────────────────────────

export const vpsRunTool: UnifiedTool = {
  name: "vps_run",
  description:
    "Run one command inside an ephemeral Docker sandbox on the VPS (2 CPU / 2 GB, " +
    "no network by default, hard timeout). Outputs written to /work are uploaded " +
    "to S3 under agent-runs/{run_id}/ and the sandbox is deleted. Requires founder " +
    "approval. Use for overnight research jobs, report generation, and builds that " +
    "must not run on the Mac.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run inside the container at /work" },
      brief: { type: "string", description: "Optional context written to /work/BRIEF.md before the command runs" },
      run_id: { type: "string", description: "Optional run id (lowercase alnum/hyphens); generated when omitted" },
      image: { type: "string", description: `Container image; allowlist: ${VPS_RUN_PROFILE.imageAllowlist.join(", ")}` },
      network: { type: "string", enum: ["none", "bridge"], description: "Container network (default none)" },
      timeout_minutes: { type: "number", description: `Hard cap ${VPS_RUN_PROFILE.maxTimeoutMinutes} min (default ${VPS_RUN_PROFILE.defaultTimeoutMinutes})` },
    },
    required: ["command"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const validated = validateVpsRunInput(args);
    if (!validated.ok) return { success: false, error: validated.error };
    const input = validated.input;

    const cfg = (args["_configOverride"] as VpsRunConfig | undefined) ?? resolveVpsRunConfig();
    if (!cfg) {
      return { success: false, error: "vps-config: vps_run is not configured — set VPS_RUN_HOST (and VPS_RUN_SSH_KEY) in the environment." };
    }
    const ssh = (args["_ssh"] as SshRunner | undefined) ?? makeSshRunner(cfg);
    const upload = (args["_upload"] as ArtifactUploader | undefined) ?? uploadFile;

    const runDir = `${cfg.runsRoot}/${input.run_id}`;
    const workDir = `${runDir}/work`;

    try {
      // 1. Prepare sandbox dir + BRIEF.md (brief travels on stdin, never quoted).
      const prep = await ssh(`mkdir -p ${workDir} && cat > ${workDir}/BRIEF.md`, {
        stdin: input.brief ?? `# ${input.run_id}\n${input.command}\n`,
        timeoutMs: 30_000,
      });
      if (prep.code !== 0) {
        return { success: false, error: `vps-ssh: sandbox preparation failed (exit ${prep.code}): ${prep.stderr.slice(0, 500)}` };
      }

      // 2. Run the container, bounded by `timeout` on the remote side and a
      //    slightly longer SSH kill on ours.
      const docker = await ssh(buildDockerCommand(input, cfg.runsRoot), {
        timeoutMs: (input.timeoutMinutes * 60 + 60) * 1000,
      });
      const stdoutTail = docker.stdout.toString("utf8").slice(-VPS_RUN_PROFILE.stdoutTailChars);

      // 3. Harvest artifacts REGARDLESS of exit code — partial outputs and logs
      //    are the evidence the founder needs when a job fails.
      const { artifacts, harvestError } = await harvestArtifacts(ssh, upload, input.run_id, runDir);

      // 4. Cleanup. Fail-open: the artifacts are already durable in S3, and a
      //    leftover directory must not turn a finished job into a failure.
      // allow-failopen: sandbox cleanup is best-effort; artifacts already uploaded
      await ssh(`rm -rf ${runDir}`, { timeoutMs: 30_000 }).catch(() =>
        log.warn({ runDir }, "vps_run: sandbox cleanup failed (left for ops sweep)"),
      );

      const workspace: WorkspaceHandle = WorkspaceHandleSchema.parse({
        run_id: input.run_id,
        kind: "vps-docker",
        local_dir: "/work",
        s3_prefix: `agent-runs/${input.run_id}`,
        expires_at: new Date(Date.now() + input.timeoutMinutes * 60_000).toISOString(),
      });
      const data: VpsRunData = { run_id: input.run_id, exit_code: docker.code, stdout_tail: stdoutTail, artifacts, workspace };

      if (docker.code !== 0) {
        const reason = docker.code === 124 ? `timed out after ${input.timeoutMinutes} min` : `exited ${docker.code}`;
        return {
          success: false,
          error: `vps-docker: container ${reason}. stderr: ${docker.stderr.slice(0, 500)}${harvestError ? ` | ${harvestError}` : ""}`,
          data,
        };
      }
      if (harvestError) {
        return { success: false, error: harvestError, data };
      }
      log.info({ run_id: input.run_id, artifacts: artifacts.length }, "vps_run completed");
      return { success: true, data };
    } catch (err) {
      return { success: false, error: `vps-ssh: ${(err as Error).message}` };
    }
  },
};

/** List small files under work/ and upload each to S3. Never throws. */
async function harvestArtifacts(
  ssh: SshRunner,
  upload: ArtifactUploader,
  runId: string,
  runDir: string,
): Promise<{ artifacts: VpsRunArtifact[]; harvestError?: string }> {
  const artifacts: VpsRunArtifact[] = [];
  try {
    const list = await ssh(
      `cd ${runDir} && find work -type f -size -${VPS_RUN_PROFILE.maxArtifactBytes}c | head -n ${VPS_RUN_PROFILE.maxArtifacts}`,
      { timeoutMs: 30_000 },
    );
    if (list.code !== 0) {
      return { artifacts, harvestError: `vps-artifacts: listing outputs failed (exit ${list.code}): ${list.stderr.slice(0, 300)}` };
    }
    const paths = list.stdout.toString("utf8").split("\n").map((p) => p.trim()).filter(Boolean);
    for (const path of paths) {
      const file = await ssh(`cat ${runDir}/${shellQuote(path)}`, { timeoutMs: 60_000 });
      if (file.code !== 0) {
        return { artifacts, harvestError: `vps-artifacts: reading ${path} failed (exit ${file.code})` };
      }
      const s3Key = await upload(file.stdout, basename(path), runId, "agent-runs");
      artifacts.push({ path, s3_key: s3Key, bytes: file.stdout.length });
    }
    return { artifacts };
  } catch (err) {
    return { artifacts, harvestError: `vps-artifacts: ${(err as Error).message}` };
  }
}
